import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { TransportTaskEntity } from './entities/transport-task.entity';
import { TaskOrderEntity, TaskOrderState } from './entities/task-order.entity';
import { TransportTaskStateMachine } from './domain/transport-task.state-machine';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';

const MIN_ORDER_AGE_MS = 10_000;
const ORPHAN_REASON = 'Task đã kết thúc — rút lệnh còn sót';

const ENDED_ROW_STATE: Readonly<Record<string, TaskOrderState>> = {
  FINISHED: TaskOrderState.FINISHED,
  FAILED: TaskOrderState.FAILED,
  UNROUTABLE: TaskOrderState.FAILED,
  WITHDRAWN: TaskOrderState.WITHDRAWN,
};

@Injectable()
export class OrphanOrderSweeper {
  private readonly logger = new Logger(OrphanOrderSweeper.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(TaskOrderEntity)
    private readonly taskOrderRepo: Repository<TaskOrderEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly transportOrders: TransportOrderService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  async run(): Promise<void> {
    try {
      for (const { row, task } of await this.ordersOfEndedTasks()) {
        await this.sweep(row, task);
      }
    } catch (err) {
      this.logger.warn(`Orphan order sweep failed: ${(err as Error).message}`);
    }
  }

  private async ordersOfEndedTasks(): Promise<
    { row: TaskOrderEntity; task: TransportTaskEntity }[]
  > {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return [];
    const rows = await this.taskOrderRepo.find({
      where: {
        state: TaskOrderState.ACTIVE,
        createdAt: LessThan(new Date(Date.now() - MIN_ORDER_AGE_MS)),
      },
    });
    if (rows.length === 0) return [];

    const tasks = await this.taskRepo.find({
      where: {
        id: In([...new Set(rows.map((row) => row.taskId))]),
        mapRecordId,
      },
    });
    const endedById = new Map(
      tasks
        .filter((task) =>
          TransportTaskStateMachine.isTerminal(task.status, task.kind),
        )
        .map((task) => [task.id, task]),
    );
    return rows.flatMap((row) => {
      const task = endedById.get(row.taskId);
      return task ? [{ row, task }] : [];
    });
  }

  private async sweep(
    row: TaskOrderEntity,
    task: TransportTaskEntity,
  ): Promise<void> {
    const kernelState = await this.kernelApi.getTransportOrderStateStrict(
      row.orderName,
    );
    const endedState =
      kernelState === null
        ? TaskOrderState.FAILED
        : ENDED_ROW_STATE[kernelState];
    if (endedState) {
      await this.taskOrderRepo.update(
        { id: row.id, state: TaskOrderState.ACTIVE },
        { state: endedState, endedAt: new Date() },
      );
      return;
    }

    await this.transportOrders.cancel(row.orderName, {
      immediate: false,
      reason: ORPHAN_REASON,
    });
    this.logger.warn(
      `Task ${task.requestCode} is ${task.status} but its ${row.leg} order ${row.orderName} was still ${kernelState} on the kernel${row.vehicleName ? ` for ${row.vehicleName}` : ''} — withdrawn`,
    );
  }
}
