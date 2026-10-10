import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AgvEntity } from '../agvs/entities/agv.entity';
import {
  TaskOrderEntity,
  TaskOrderState,
  type TaskOrderLeg,
} from './entities/task-order.entity';
import {
  FMS_EVENTS,
  FmsTaskOrderStateEvent,
  KERNEL_ORDER_LOST,
  TASK_ORDER_EVENTS,
  TaskOrderChangedEvent,
  TaskOrderEndedEvent,
  TaskOrderIssuedEvent,
  TaskOrderWithdrawingEvent,
  type TaskOrderOutcome,
} from './domain/events';
import {
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';

const KERNEL_OUTCOME: Readonly<Record<string, TaskOrderOutcome>> = {
  BEING_PROCESSED: 'STARTED',
  FINISHED: 'FINISHED',
  FAILED: 'FAILED',
  UNROUTABLE: 'FAILED',
  WITHDRAWN: 'WITHDRAWN_EXTERNALLY',
  [KERNEL_ORDER_LOST]: 'LOST',
};

const LIVE_TASK_STATUSES = [
  TaskStatus.PICKING_UP,
  TaskStatus.DELIVERING,
  TaskStatus.CREATED,
  TaskStatus.EXECUTING,
];

const WITHDRAWABLE_STATES = [TaskOrderState.ACTIVE, TaskOrderState.WITHDRAWING];

const OPEN_STATES_SQL = WITHDRAWABLE_STATES.map((state) => `'${state}'`).join(
  ', ',
);

export interface OpenTaskOrder {
  row: TaskOrderEntity;
  requestCode: string;
  replacingOrderName: string | null;
}

const ENDED_STATE: Readonly<
  Record<Exclude<TaskOrderOutcome, 'STARTED'>, TaskOrderState>
> = {
  FINISHED: TaskOrderState.FINISHED,
  FAILED: TaskOrderState.FAILED,
  PREEMPTED: TaskOrderState.PREEMPTED,
  WITHDRAWN_EXTERNALLY: TaskOrderState.FAILED,
  LOST: TaskOrderState.FAILED,
};

@Injectable()
export class TaskOrderService {
  private readonly logger = new Logger(TaskOrderService.name);

  constructor(
    @InjectRepository(TaskOrderEntity)
    private readonly repo: Repository<TaskOrderEntity>,
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(AgvEntity)
    private readonly agvRepo: Repository<AgvEntity>,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(TASK_ORDER_EVENTS.ISSUED, { promisify: true })
  async onIssued(event: TaskOrderIssuedEvent): Promise<void> {
    await this.record(
      event.taskId,
      event.orderName,
      event.leg as TaskOrderLeg,
      event.vehicleName,
      [...event.destinations],
    );
  }

  @OnEvent(TASK_ORDER_EVENTS.WITHDRAWING, { promisify: true })
  async onWithdrawing(event: TaskOrderWithdrawingEvent): Promise<void> {
    await this.repo.update(
      { orderName: event.orderName, state: TaskOrderState.ACTIVE },
      { state: TaskOrderState.WITHDRAWING, endReason: event.reason },
    );
    this.changed(event.orderName);
  }

  @OnEvent(TASK_ORDER_EVENTS.WITHDRAW_REFUSED, { promisify: true })
  async onWithdrawRefused(event: TaskOrderWithdrawingEvent): Promise<void> {
    await this.repo.update(
      { orderName: event.orderName, state: TaskOrderState.WITHDRAWING },
      { state: TaskOrderState.ACTIVE, endReason: null },
    );
    this.changed(event.orderName);
  }

  @OnEvent(TASK_ORDER_EVENTS.WITHDRAWN, { promisify: true })
  async onWithdrawn(event: TaskOrderWithdrawingEvent): Promise<void> {
    const replacement = event.replacedBy
      ? await this.repo.findOne({ where: { orderName: event.replacedBy } })
      : null;
    await this.repo.update(
      {
        orderName: event.orderName,
        state: In(
          event.replacedBy
            ? [...WITHDRAWABLE_STATES, TaskOrderState.REPLACED]
            : WITHDRAWABLE_STATES,
        ),
      },
      {
        state: event.replacedBy
          ? TaskOrderState.REPLACED
          : TaskOrderState.WITHDRAWN,
        kernelState: 'WITHDRAWN',
        replacedBy: event.replacedBy,
        replacementOrderId: replacement?.id ?? null,
        endReason: event.reason,
        endedAt: new Date(),
      },
    );
    this.changed(event.orderName);
  }

  @OnEvent(FMS_EVENTS.TASK_ORDER_STATE_CHANGED)
  async onKernelState(event: FmsTaskOrderStateEvent): Promise<void> {
    const row =
      (await this.repo.findOne({ where: { orderName: event.orderName } })) ??
      (event.taskId && event.leg
        ? await this.record(
            event.taskId,
            event.orderName,
            event.leg as TaskOrderLeg,
            event.processingVehicle,
            [],
          )
        : null);
    if (!row) return;
    try {
      await this.applyKernelState(row, event);
    } finally {
      this.changed(row.orderName);
    }
  }

  private async applyKernelState(
    row: TaskOrderEntity,
    event: FmsTaskOrderStateEvent,
  ): Promise<void> {
    const vehicleName = event.processingVehicle ?? row.vehicleName;
    const agvId = await this.resolveAgvId(row.taskId, vehicleName);
    const finishedDestinations = Math.max(
      row.finishedDestinations ?? 0,
      event.finishedDriveOrders ?? 0,
    );
    const kernelOutcome = KERNEL_OUTCOME[event.orderState];
    if (!kernelOutcome) {
      await this.repo.update(
        { id: row.id },
        {
          kernelState: event.orderState,
          vehicleName,
          agvId,
          finishedDestinations,
        },
      );
      return;
    }
    const outcome =
      kernelOutcome === 'WITHDRAWN_EXTERNALLY' && row.leg === 'PARK'
        ? 'PREEMPTED'
        : kernelOutcome;

    if (outcome === 'STARTED') {
      const firstStart = !row.startedAt;
      await this.repo.update(
        { id: row.id },
        {
          kernelState: event.orderState,
          vehicleName,
          agvId,
          finishedDestinations,
          startedAt: row.startedAt ?? new Date(),
        },
      );
      if (!firstStart || row.state !== TaskOrderState.ACTIVE) return;
    } else {
      if (row.state !== TaskOrderState.ACTIVE) {
        await this.repo.update(
          { id: row.id },
          {
            kernelState: event.orderState,
            vehicleName,
            agvId,
            finishedDestinations,
          },
        );
        return;
      }
      await this.repo.update(
        { id: row.id, state: TaskOrderState.ACTIVE },
        {
          state: ENDED_STATE[outcome],
          kernelState: event.orderState,
          vehicleName,
          agvId,
          finishedDestinations,
          endReason: failureReason(event.orderState, outcome),
          endedAt: new Date(),
        },
      );
    }

    this.events.emit(
      TASK_ORDER_EVENTS.ENDED,
      new TaskOrderEndedEvent(
        row.taskId,
        row.orderName,
        row.leg,
        outcome,
        vehicleName,
      ),
    );
  }

  async beginReplacement(orderName: string, reason: string): Promise<void> {
    await this.repo.update(
      { orderName, state: TaskOrderState.ACTIVE },
      {
        state: TaskOrderState.REPLACED,
        endReason: reason,
        endedAt: new Date(),
      },
    );
    this.changed(orderName);
  }

  async markReplacedBy(orderName: string, replacedBy: string): Promise<void> {
    await this.repo.update(
      { orderName, state: TaskOrderState.REPLACED },
      { replacedBy },
    );
    this.changed(orderName);
  }

  async linkRecreation(orderName: string, replacedBy: string): Promise<void> {
    const replacement = await this.repo.findOne({
      where: { orderName: replacedBy },
    });
    await this.repo.update(
      {
        orderName,
        state: In([TaskOrderState.ACTIVE, TaskOrderState.FAILED]),
      },
      {
        state: TaskOrderState.REPLACED,
        replacedBy,
        replacementOrderId: replacement?.id ?? null,
      },
    );
    this.changed(orderName);
  }

  endedWithoutSuccessor(mapRecordId: string): Promise<TaskOrderEntity[]> {
    return this.repo
      .createQueryBuilder('o')
      .innerJoin(TransportTaskEntity, 'task', 'task.id = o.task_id')
      .where('o.state = :state', { state: TaskOrderState.FAILED })
      .andWhere('o.replaced_by IS NULL')
      .andWhere("o.leg <> 'PARK'")
      .andWhere('task.map_record_id = :mapRecordId', { mapRecordId })
      .andWhere('task.status IN (:...live)', { live: LIVE_TASK_STATUSES })
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM transport_request_orders later WHERE later.task_id = o.task_id AND later.seq > o.seq)',
      )
      .orderBy('o.ended_at', 'ASC')
      .getMany();
  }

  async abortReplacement(orderName: string): Promise<void> {
    await this.repo.update(
      {
        orderName,
        state: TaskOrderState.REPLACED,
        replacedBy: IsNull(),
      },
      { state: TaskOrderState.ACTIVE, endReason: null, endedAt: null },
    );
    this.changed(orderName);
  }

  async openOrdersOn(
    mapRecordId: string,
    createdBefore: Date,
  ): Promise<OpenTaskOrder[]> {
    const { entities, raw } = await this.repo
      .createQueryBuilder('o')
      .innerJoin(TransportTaskEntity, 'task', 'task.id = o.task_id')
      .addSelect('task.request_code', 'request_code')
      .addSelect(
        "task.metadata ->> 'replacingOrderName'",
        'replacing_order_name',
      )
      .where(`o.state IN (${OPEN_STATES_SQL})`)
      .andWhere('task.map_record_id = :mapRecordId', { mapRecordId })
      .andWhere('o.created_at < :createdBefore', { createdBefore })
      .orderBy('o.created_at', 'ASC')
      .getRawAndEntities<{
        request_code: string | null;
        replacing_order_name: string | null;
      }>();
    return entities.map((row, index) => ({
      row,
      requestCode: raw[index]?.request_code ?? row.taskId,
      replacingOrderName: raw[index]?.replacing_order_name ?? null,
    }));
  }

  recentlyEndedOn(
    mapRecordId: string,
    since: Date,
    limit: number,
  ): Promise<TaskOrderEntity[]> {
    return this.repo
      .createQueryBuilder('o')
      .innerJoin(TransportTaskEntity, 'task', 'task.id = o.task_id')
      .where('o.ended_at >= :since', { since })
      .andWhere('task.map_record_id = :mapRecordId', { mapRecordId })
      .orderBy('o.ended_at', 'DESC')
      .limit(limit)
      .getMany();
  }

  ordersOf(taskIds: readonly string[]): Promise<TaskOrderEntity[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.repo.find({
      where: { taskId: In([...taskIds]) },
      order: { seq: 'ASC' },
    });
  }

  async activeOrderNames(taskId: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { taskId, state: TaskOrderState.ACTIVE },
      order: { seq: 'ASC' },
    });
    return rows.map((row) => row.orderName);
  }

  findByOrderName(orderName: string): Promise<TaskOrderEntity | null> {
    return this.repo.findOne({ where: { orderName } });
  }

  latestOrder(
    taskId: string,
    leg: TaskOrderLeg,
  ): Promise<TaskOrderEntity | null> {
    return this.repo.findOne({
      where: { taskId, leg },
      order: { seq: 'DESC' },
    });
  }

  latestActiveOrder(
    taskId: string,
    leg: TaskOrderLeg,
  ): Promise<TaskOrderEntity | null> {
    return this.repo.findOne({
      where: { taskId, leg, state: TaskOrderState.ACTIVE },
      order: { seq: 'DESC' },
    });
  }

  private async record(
    taskId: string,
    orderName: string,
    leg: TaskOrderLeg,
    vehicleName: string | null,
    destinations: TaskOrderEntity['destinations'],
  ): Promise<TaskOrderEntity | null> {
    const seq = ((await this.repo.maximum('seq', { taskId })) ?? 0) + 1;
    const agvId = await this.resolveAgvId(taskId, vehicleName);
    try {
      await this.repo
        .createQueryBuilder()
        .insert()
        .values({
          taskId,
          orderName,
          leg,
          vehicleName,
          agvId,
          destinations,
          seq,
        })
        .orIgnore()
        .execute();
      if (destinations.length > 0) {
        await this.fillMissingDestinations(orderName, destinations);
      }
    } catch (err) {
      this.logger.warn(
        `Could not record order ${orderName} of task ${taskId}: ${(err as Error).message}`,
      );
      return null;
    }
    this.changed(orderName);
    return this.repo.findOne({ where: { orderName } });
  }

  private async fillMissingDestinations(
    orderName: string,
    destinations: TaskOrderEntity['destinations'],
  ): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({ destinations })
      .where('order_name = :orderName', { orderName })
      .andWhere('jsonb_array_length(destinations) = 0')
      .execute();
  }

  private changed(orderName: string): void {
    this.events.emit(
      TASK_ORDER_EVENTS.CHANGED,
      new TaskOrderChangedEvent(orderName),
    );
  }

  private async resolveAgvId(
    taskId: string,
    vehicleName: string | null,
  ): Promise<string | null> {
    if (!vehicleName) return null;
    const task = await this.taskRepo.findOne({
      where: { id: taskId },
      select: { id: true, mapRecordId: true },
    });
    const matches = await this.agvRepo.find({
      where: task?.mapRecordId
        ? { name: vehicleName, mapRecordId: task.mapRecordId }
        : { name: vehicleName },
      select: { id: true },
    });
    return matches.length === 1 ? matches[0].id : null;
  }
}

function failureReason(
  kernelState: string,
  outcome: TaskOrderOutcome,
): string | null {
  return outcome === 'FAILED' ||
    outcome === 'LOST' ||
    outcome === 'WITHDRAWN_EXTERNALLY'
    ? `FMS order state: ${kernelState}`
    : null;
}
