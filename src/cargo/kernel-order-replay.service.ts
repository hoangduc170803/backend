import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { KernelSessionService } from '../kernel-session/kernel-session.service';
import type {
  KernelRestoreContext,
  KernelRestoreStep,
} from '../kernel-session/domain/kernel-session';
import {
  TaskOrderState,
  type TaskOrderEntity,
} from './entities/task-order.entity';
import { TransportTaskEntity } from './entities/transport-task.entity';
import { TransportTaskStateMachine } from './domain/transport-task.state-machine';
import {
  FMS_EVENTS,
  FmsTaskOrderStateEvent,
  FmsTransportOrderFinishedEvent,
} from './domain/events';
import { cargoLegOf } from './domain/order-replay';
import { remainingDestinations } from './domain/remaining-destinations';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { TaskOrderService } from './task-order.service';
import { OrderReplacementService } from './order-replacement.service';
import { DirectTaskService } from './direct-task.service';

const REPLAY_REASON =
  'Kernel khởi động lại — phát lại lệnh cuối cùng WES ghi nhận';

export class KernelUnreachableDuringReplay extends Error {}

@Injectable()
export class KernelOrderReplayService
  implements OnModuleInit, KernelRestoreStep
{
  readonly name = 'Phát lại lệnh vận chuyển';
  readonly order = 40;
  private readonly logger = new Logger(KernelOrderReplayService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly taskOrders: TaskOrderService,
    private readonly kernelApi: KernelApiService,
    private readonly replacement: OrderReplacementService,
    private readonly directTasks: DirectTaskService,
    private readonly session: KernelSessionService,
    private readonly events: EventEmitter2,
    private readonly vehicleStore: VehicleStateStore,
  ) {}

  onModuleInit(): void {
    this.session.registerStep(this);
  }

  async run(context: KernelRestoreContext): Promise<void> {
    const tasks = (
      await this.taskRepo.find({ where: { mapRecordId: context.mapRecordId } })
    ).filter(
      (task) => !TransportTaskStateMachine.isTerminal(task.status, task.kind),
    );
    if (tasks.length === 0) return;

    const rows = await this.taskOrders.ordersOf(tasks.map((task) => task.id));
    let replayed = 0;
    for (const task of tasks) {
      const active = rows.filter(
        (row) => row.taskId === task.id && row.state === TaskOrderState.ACTIVE,
      );
      for (const row of active) {
        if (await this.replayRow(task, row)) replayed++;
      }
      if (active.length === 0 && task.metadata?.pendingOrder) {
        if (await this.issuePending(task)) replayed++;
      }
    }
    this.logger.log(
      `Order replay (${context.reason}): ${replayed} order(s) re-created for ${tasks.length} live task(s)`,
    );
  }

  private async replayRow(
    task: TransportTaskEntity,
    row: TaskOrderEntity,
  ): Promise<boolean> {
    const kernelState = await this.kernelApi.getTransportOrderStateStrict(
      row.orderName,
    );
    if (kernelState !== null) return false;

    const destinations = remainingDestinations(
      row,
      this.loadStateOf(task, row),
      {
        load: this.kernelApi.loadOperation,
        unload: this.kernelApi.unloadOperation,
      },
    );
    if (destinations === null) {
      this.logger.error(
        `Task ${task.requestCode}: ${row.orderName} was recorded without its destinations — it cannot be replayed and is left open, not closed`,
      );
      return false;
    }
    if (destinations.length === 0) {
      await this.finishLeg(task, row);
      return false;
    }

    try {
      await this.replacement.replayLost(row, task, destinations, REPLAY_REASON);
      return true;
    } catch (err) {
      await this.rethrowIfKernelDown(err);
      this.logger.error(
        `Task ${task.requestCode}: could not replay ${row.orderName} — ${(err as Error).message}`,
      );
      return false;
    }
  }

  private loadStateOf(
    task: TransportTaskEntity,
    row: TaskOrderEntity,
  ): boolean | null {
    if (row.leg === 'DROPOFF' && task.metadata?.unloadedAt) return false;
    const vehicleName =
      row.vehicleName ?? task.metadata?.assignedVehicleName ?? null;
    const reported = vehicleName
      ? this.vehicleStore.get(vehicleName)?.loaded
      : undefined;
    return typeof reported === 'boolean' ? reported : null;
  }

  private async issuePending(task: TransportTaskEntity): Promise<boolean> {
    try {
      await this.directTasks.issuePending(task);
      return true;
    } catch (err) {
      await this.rethrowIfKernelDown(err);
      this.logger.error(
        `Task ${task.requestCode}: could not issue its queued order — ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async finishLeg(
    task: TransportTaskEntity,
    row: TaskOrderEntity,
  ): Promise<void> {
    this.logger.log(
      `Task ${task.requestCode}: ${row.orderName} had nothing left to do — closing the leg`,
    );
    await this.events.emitAsync(
      FMS_EVENTS.TASK_ORDER_STATE_CHANGED,
      new FmsTaskOrderStateEvent(
        row.orderName,
        task.id,
        row.leg,
        'FINISHED',
        row.vehicleName,
      ),
    );
    const leg = cargoLegOf(row.leg);
    if (leg) {
      this.events.emit(
        FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
        new FmsTransportOrderFinishedEvent(row.orderName, task.id, leg),
      );
    }
  }

  private async rethrowIfKernelDown(err: unknown): Promise<void> {
    if (!(await this.kernelApi.isReachable())) {
      throw new KernelUnreachableDuringReplay((err as Error).message);
    }
  }
}
