import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type { TransportOrderDestination } from '../opentcs/domain/kernel-model';
import {
  TaskOrderState,
  type TaskOrderEntity,
} from './entities/task-order.entity';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { TransportTaskStateMachine } from './domain/transport-task.state-machine';
import { TASK_ORDER_EVENTS, TaskOrderEndedEvent } from './domain/events';
import {
  MAX_ORDER_RECREATIONS,
  RECREATED_OUTCOMES,
  exhaustedReason,
  spendRecreation,
} from './domain/order-recreation';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  OrderReplacementService,
  remainingDestinations,
} from './order-replacement.service';
import { TaskOrderService } from './task-order.service';
import { TransportTaskService } from './transport-task.service';

const RECREATABLE_STATES: ReadonlySet<TaskOrderState> = new Set([
  TaskOrderState.ACTIVE,
  TaskOrderState.FAILED,
]);
const RECREATE_REASON = 'Hệ thống điều khiển huỷ lệnh — WES tạo lại';

export type RecreationResult = 'recreated' | 'exhausted' | 'not-applicable';

@Injectable()
export class OrderRecreationService {
  private readonly logger = new Logger(OrderRecreationService.name);
  private readonly queues = new Map<string, Promise<RecreationResult>>();

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly taskOrders: TaskOrderService,
    private readonly replacement: OrderReplacementService,
    private readonly transportTask: TransportTaskService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  @OnEvent(TASK_ORDER_EVENTS.ENDED)
  async onOrderEnded(event: TaskOrderEndedEvent): Promise<void> {
    if (!RECREATED_OUTCOMES.has(event.outcome)) return;
    await this.recreate(event.taskId, event.orderName);
  }

  async run(): Promise<void> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return;
    for (const row of await this.taskOrders.endedWithoutSuccessor(
      mapRecordId,
    )) {
      await this.recreate(row.taskId, row.orderName);
    }
  }

  recreate(taskId: string, orderName: string): Promise<RecreationResult> {
    const previous = this.queues.get(taskId) ?? Promise.resolve('recreated');
    const next = previous
      .catch(() => 'not-applicable' as const)
      .then(() => this.recreateNow(taskId, orderName))
      .catch((err: unknown): RecreationResult => {
        this.logger.warn(
          `Task ${taskId}: could not recreate ${orderName} — ${(err as Error).message}; the next reconcile pass retries`,
        );
        return 'recreated';
      })
      .finally(() => {
        if (this.queues.get(taskId) === next) this.queues.delete(taskId);
      });
    this.queues.set(taskId, next);
    return next;
  }

  private async recreateNow(
    taskId: string,
    orderName: string,
  ): Promise<RecreationResult> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    const row = await this.taskOrders.findByOrderName(orderName);
    if (!task || !row || row.leg === 'PARK' || task.kind === TaskKind.PARK) {
      return 'not-applicable';
    }
    if (TransportTaskStateMachine.isTerminal(task.status, task.kind)) {
      return 'not-applicable';
    }
    if (!RECREATABLE_STATES.has(row.state)) return 'not-applicable';
    if (task.metadata?.replacingOrderName) return 'recreated';
    if (await this.hasNewerLiveOrder(task, row)) return 'recreated';
    if (this.wasRequeued(task, row)) return 'recreated';

    const decision = spendRecreation(
      task.metadata?.orderRecreation,
      orderName,
      new Date(),
    );
    if (!decision.allowed) {
      this.logger.error(
        `Task ${task.requestCode}: FMS ended ${orderName} after ${decision.spent} recreation(s) — giving up`,
      );
      const reason = exhaustedReason(orderName);
      task.metadata = { ...task.metadata, blockedReason: reason };
      await this.transportTask.changeStatus(task, TaskStatus.FAILED, {
        trigger: 'ORDER_RECREATION',
        vehicleName: row.vehicleName,
        reason,
        context: { orderName, recreations: decision.spent },
      });
      return 'exhausted';
    }
    if (row.leg === 'PICKUP') {
      task.metadata = { ...task.metadata, orderRecreation: decision.next };
      await this.requeuePickup(task, row, decision.next.count);
      return 'recreated';
    }

    const destinations = await this.destinationsLeft(row);
    if (destinations.length === 0) {
      this.logger.warn(
        `Task ${task.requestCode}: ${orderName} ended by FMS with every destination done — nothing to recreate`,
      );
      return 'not-applicable';
    }
    const replacedBy = await this.replacement.recreateEnded(
      row,
      task,
      destinations,
      RECREATE_REASON,
    );
    task.metadata = { ...task.metadata, orderRecreation: decision.next };
    await this.taskRepo.save(task);
    this.transportTask.publishUpdated(task);
    this.logger.warn(
      `Task ${task.requestCode}: FMS ended ${orderName} — recreated as ${replacedBy} (${decision.next.count}/${MAX_ORDER_RECREATIONS})`,
    );
    return 'recreated';
  }

  private async hasNewerLiveOrder(
    task: TransportTaskEntity,
    row: TaskOrderEntity,
  ): Promise<boolean> {
    if (task.metadata?.pendingDropoff && row.leg === 'APPROACH') return true;
    const rows = await this.taskOrders.ordersOf([task.id]);
    return rows.some(
      (other) =>
        other.id !== row.id &&
        other.seq > row.seq &&
        other.state === TaskOrderState.ACTIVE,
    );
  }

  private wasRequeued(task: TransportTaskEntity, row: TaskOrderEntity) {
    return row.leg === 'PICKUP' && task.status !== TaskStatus.PICKING_UP;
  }

  private async requeuePickup(
    task: TransportTaskEntity,
    row: TaskOrderEntity,
    count: number,
  ): Promise<void> {
    task.metadata = {
      ...task.metadata,
      pickupOrderName: undefined,
      assignedVehicleName: undefined,
    };
    task.assignedAt = null;
    task.startedAt = null;
    await this.transportTask.changeStatus(task, TaskStatus.READY_TO_ASSIGN, {
      trigger: 'ORDER_RECREATION',
      vehicleName: row.vehicleName,
      reason: RECREATE_REASON,
      context: { orderName: row.orderName, recreations: count },
    });
    this.logger.warn(
      `Task ${task.requestCode}: FMS ended ${row.orderName} — back to READY_TO_ASSIGN for a new pickup order (${count}/${MAX_ORDER_RECREATIONS})`,
    );
  }

  private async destinationsLeft(
    row: TaskOrderEntity,
  ): Promise<TransportOrderDestination[]> {
    const recorded = (row.destinations ?? []).slice(row.finishedDestinations);
    try {
      const order = (await this.kernelApi.getTransportOrderRaw(
        row.orderName,
      )) as Parameters<typeof remainingDestinations>[0] | null;
      return order ? remainingDestinations(order) : recorded;
    } catch {
      return recorded;
    }
  }
}
