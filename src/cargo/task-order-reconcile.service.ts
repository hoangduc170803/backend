import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskOrderEntity, TaskOrderState } from './entities/task-order.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { TaskOrderService, type OpenTaskOrder } from './task-order.service';
import {
  FMS_EVENTS,
  FmsTaskOrderStateEvent,
  KERNEL_ORDER_LOST,
  TaskOrderWithdrawingEvent,
} from './domain/events';
import { KernelSessionService } from '../kernel-session/kernel-session.service';

const MIN_ORDER_AGE_MS = 10_000;
const ENDED_KERNEL_STATES = new Set([
  'FINISHED',
  'FAILED',
  'UNROUTABLE',
  'WITHDRAWN',
]);

@Injectable()
export class TaskOrderReconcileService {
  private readonly logger = new Logger(TaskOrderReconcileService.name);

  constructor(
    private readonly taskOrders: TaskOrderService,
    private readonly kernelApi: KernelApiService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly activeMap: ActiveMapContext,
    private readonly events: EventEmitter2,
    private readonly kernelSession: KernelSessionService,
  ) {}

  async run(): Promise<void> {
    if (!this.vehicleStore.isConnected()) return;
    try {
      for (const order of await this.unconfirmedOrders()) {
        await this.reconcileOrder(order);
      }
    } catch (err) {
      this.logger.warn(
        `Task order reconcile failed: ${(err as Error).message}`,
      );
    }
  }

  private async unconfirmedOrders(): Promise<OpenTaskOrder[]> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return [];
    const settledBefore = new Date(Date.now() - MIN_ORDER_AGE_MS);
    const open = await this.taskOrders.openOrdersOn(mapRecordId, settledBefore);
    return open.filter(
      ({ row, replacingOrderName }) =>
        !this.isDriving(row) && replacingOrderName !== row.orderName,
    );
  }

  private isDriving(row: TaskOrderEntity): boolean {
    return (
      !!row.vehicleName &&
      this.vehicleStore.get(row.vehicleName)?.transportOrder === row.orderName
    );
  }

  private async reconcileOrder({
    row,
    requestCode,
  }: OpenTaskOrder): Promise<void> {
    let kernelState: string | null;
    try {
      kernelState = await this.kernelApi.getTransportOrderStateStrict(
        row.orderName,
      );
    } catch (err) {
      this.logger.debug(
        `Cannot confirm ${row.orderName} — retrying next pass: ${(err as Error).message}`,
      );
      return;
    }
    const endedOnKernel =
      kernelState === null || ENDED_KERNEL_STATES.has(kernelState);

    if (row.state === TaskOrderState.WITHDRAWING) {
      await this.settleInterruptedWithdrawal(row, endedOnKernel);
      return;
    }
    if (!endedOnKernel) return;
    if (kernelState === null && !(await this.kernelSession.confirmIntact())) {
      this.logger.warn(
        `Order ${row.orderName} of task ${requestCode} is gone because the kernel was reset — leaving it to the restore`,
      );
      return;
    }

    const replayedState = kernelState ?? KERNEL_ORDER_LOST;
    this.logger.warn(
      `Order ${row.orderName} of task ${requestCode} is ${replayedState} on the kernel but still ACTIVE in WES — closing it`,
    );
    await this.events.emitAsync(
      FMS_EVENTS.TASK_ORDER_STATE_CHANGED,
      new FmsTaskOrderStateEvent(
        row.orderName,
        row.taskId,
        row.leg,
        replayedState,
        row.vehicleName,
      ),
    );
  }

  private async settleInterruptedWithdrawal(
    row: TaskOrderEntity,
    endedOnKernel: boolean,
  ): Promise<void> {
    const withdrawal = new TaskOrderWithdrawingEvent(
      row.orderName,
      row.endReason,
      row.replacedBy,
    );
    if (endedOnKernel) {
      await this.taskOrders.onWithdrawn(withdrawal);
      return;
    }
    this.logger.warn(
      `Order ${row.orderName} was left WITHDRAWING but still runs on the kernel — reopening it`,
    );
    await this.taskOrders.onWithdrawRefused(withdrawal);
  }
}
