import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import type { TransportOrderDestination } from '../opentcs/domain/kernel-model';
import {
  TaskOrderState,
  type TaskOrderEntity,
} from './entities/task-order.entity';
import {
  TransportTaskEntity,
  type TaskMetadata,
} from './entities/transport-task.entity';
import { TransportTaskStateMachine } from './domain/transport-task.state-machine';
import { TASK_ORDER_EVENTS, TaskOrderReplacedEvent } from './domain/events';
import { TaskOrderService } from './task-order.service';
import { TransportTaskService } from './transport-task.service';

const TERMINAL_KERNEL_STATES = new Set(['FINISHED', 'FAILED', 'UNROUTABLE']);
const REPLACE_REASON = 'Rút từ tab Lệnh — tạo lại để chạy tiếp';
const RAW_WITHDRAW_REASON = 'Rút từ tab Lệnh';

const LEG_METADATA_KEY: Readonly<Partial<Record<string, keyof TaskMetadata>>> =
  {
    PICKUP: 'pickupOrderName',
    APPROACH: 'approachOrderName',
    DROPOFF: 'dropoffOrderName',
  };

interface RawKernelOrder {
  state?: string;
  processingVehicle?: string | null;
  intendedVehicle?: string | null;
  destinations?: {
    locationName?: string;
    operation?: string;
    state?: string;
  }[];
}

export interface OrderWithdrawalResult {
  readonly orderName: string;
  readonly replacedBy: string | null;
  readonly taskId: string | null;
}

export function remainingDestinations(
  order: RawKernelOrder,
): TransportOrderDestination[] {
  return (order.destinations ?? [])
    .filter((destination) => destination.state !== 'FINISHED')
    .filter((destination) => !!destination.locationName)
    .map((destination) => ({
      locationName: destination.locationName!,
      operation: destination.operation ?? 'NOP',
    }));
}

@Injectable()
export class OrderReplacementService {
  private readonly logger = new Logger(OrderReplacementService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly transportOrders: TransportOrderService,
    private readonly taskOrders: TaskOrderService,
    private readonly transportTask: TransportTaskService,
    private readonly events: EventEmitter2,
  ) {}

  async withdrawFromOrdersTab(
    orderName: string,
  ): Promise<OrderWithdrawalResult> {
    const row = await this.taskOrders.findByOrderName(orderName);
    const task =
      row?.state === TaskOrderState.ACTIVE
        ? await this.taskRepo.findOne({ where: { id: row.taskId } })
        : null;
    const order = task
      ? ((await this.kernelApi.getTransportOrderRaw(
          orderName,
        )) as RawKernelOrder | null)
      : null;
    const remaining = order ? remainingDestinations(order) : [];

    const replaceable =
      !!row &&
      !!task &&
      !!order &&
      (await this.isCurrentLeg(row, task)) &&
      !TERMINAL_KERNEL_STATES.has(order.state ?? '') &&
      !TransportTaskStateMachine.isTerminal(task.status, task.kind) &&
      remaining.length > 0;

    if (!replaceable) {
      await this.transportOrders.cancel(orderName, {
        immediate: true,
        reason: RAW_WITHDRAW_REASON,
      });
      return { orderName, replacedBy: null, taskId: task?.id ?? null };
    }

    const replacedBy = await this.replace(row, task, order, remaining);
    return { orderName, replacedBy, taskId: task.id };
  }

  private async isCurrentLeg(
    row: TaskOrderEntity,
    task: TransportTaskEntity,
  ): Promise<boolean> {
    const supersededApproach =
      row.leg === 'APPROACH' &&
      (!!task.metadata?.dropoffOrderName || !!task.metadata?.pendingDropoff);
    if (supersededApproach) return false;
    const rows = await this.taskOrders.ordersOf([task.id]);
    return !rows.some(
      (other) =>
        other.id !== row.id &&
        other.state === TaskOrderState.ACTIVE &&
        other.seq > row.seq,
    );
  }

  async replayLost(
    row: TaskOrderEntity,
    task: TransportTaskEntity,
    destinations: TransportOrderDestination[],
    reason: string,
  ): Promise<string> {
    const vehicleName =
      row.vehicleName ?? task.metadata?.assignedVehicleName ?? null;
    const replacedBy = await this.reissue(
      row,
      task,
      vehicleName,
      destinations,
      reason,
    );
    await this.taskOrders.markReplacedBy(row.orderName, replacedBy);
    this.events.emit(
      TASK_ORDER_EVENTS.REPLACED,
      new TaskOrderReplacedEvent(row.orderName, replacedBy, vehicleName),
    );
    this.transportTask.publishUpdated(task);
    this.logger.log(
      `Task ${task.requestCode}: ${row.orderName} lost on the kernel — replayed as ${replacedBy} (${destinations.length} destination(s))`,
    );
    return replacedBy;
  }

  async recreateEnded(
    row: TaskOrderEntity,
    task: TransportTaskEntity,
    destinations: TransportOrderDestination[],
    reason: string,
  ): Promise<string> {
    const vehicleName =
      row.vehicleName ?? task.metadata?.assignedVehicleName ?? null;
    const replacedBy = await this.reissue(
      row,
      task,
      vehicleName,
      destinations,
      reason,
    );
    await this.taskOrders.linkRecreation(row.orderName, replacedBy);
    this.events.emit(
      TASK_ORDER_EVENTS.REPLACED,
      new TaskOrderReplacedEvent(row.orderName, replacedBy, vehicleName),
    );
    this.transportTask.publishUpdated(task);
    return replacedBy;
  }

  private async replace(
    row: TaskOrderEntity,
    task: TransportTaskEntity,
    order: RawKernelOrder,
    remaining: TransportOrderDestination[],
  ): Promise<string> {
    const vehicleName =
      order.processingVehicle ??
      order.intendedVehicle ??
      row.vehicleName ??
      task.metadata?.assignedVehicleName ??
      null;
    const replacedBy = await this.reissue(
      row,
      task,
      vehicleName,
      remaining,
      REPLACE_REASON,
    );
    await this.transportOrders.cancel(row.orderName, {
      immediate: true,
      reason: REPLACE_REASON,
      replacedBy,
    });
    this.events.emit(
      TASK_ORDER_EVENTS.REPLACED,
      new TaskOrderReplacedEvent(row.orderName, replacedBy, vehicleName),
    );
    this.transportTask.publishUpdated(task);
    this.logger.log(
      `Task ${task.requestCode}: ${row.orderName} withdrawn from the Orders tab — continuing as ${replacedBy} (${remaining.length} destination(s) left)`,
    );
    return replacedBy;
  }

  private async reissue(
    row: TaskOrderEntity,
    task: TransportTaskEntity,
    vehicleName: string | null,
    destinations: TransportOrderDestination[],
    reason: string,
  ): Promise<string> {
    const aimedAt =
      replacementAim(row)?.locationName ??
      destinations[destinations.length - 1].locationName;

    await this.saveMetadata(task, { replacingOrderName: row.orderName });
    await this.taskOrders.beginReplacement(row.orderName, reason);
    let replacedBy: string;
    try {
      replacedBy = await this.transportOrders.issue({
        kind: row.leg,
        vehicleName,
        aimedAt,
        destinations,
        taskId: task.id,
        dispensable: row.leg === 'PARK',
      });
    } catch (err) {
      await this.taskOrders.abortReplacement(row.orderName);
      await this.saveMetadata(task, { replacingOrderName: undefined });
      throw err;
    }

    const legKey = LEG_METADATA_KEY[row.leg];
    await this.saveMetadata(task, {
      replacingOrderName: undefined,
      ...(legKey ? { [legKey]: replacedBy } : {}),
    });
    return replacedBy;
  }

  private async saveMetadata(
    task: TransportTaskEntity,
    patch: Partial<TaskMetadata>,
  ): Promise<void> {
    task.metadata = { ...task.metadata, ...patch };
    await this.taskRepo.save(task);
  }
}

function replacementAim(
  row: TaskOrderEntity,
): TransportOrderDestination | undefined {
  return row.leg === 'MANUAL'
    ? row.destinations?.at(-1)
    : row.destinations?.at(0);
}
