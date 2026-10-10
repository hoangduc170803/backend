import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { TransportTaskService } from './transport-task.service';
import { TransportTaskStateMachine } from './domain/transport-task.state-machine';
import {
  TASK_ORDER_EVENTS,
  TaskOrderEndedEvent,
  type TaskOrderOutcome,
} from './domain/events';
import { RECREATED_OUTCOMES } from './domain/order-recreation';

const OUTCOME_STATUS: Readonly<
  Record<Exclude<TaskOrderOutcome, 'STARTED'>, TaskStatus>
> = {
  FINISHED: TaskStatus.COMPLETED,
  FAILED: TaskStatus.FAILED,
  PREEMPTED: TaskStatus.CANCELLED,
  WITHDRAWN_EXTERNALLY: TaskStatus.CANCELLED,
  LOST: TaskStatus.FAILED,
};

const OUTCOME_REASON: Readonly<Partial<Record<TaskOrderOutcome, string>>> = {
  FAILED: 'Hệ thống điều khiển báo lệnh lỗi',
  PREEMPTED: 'Nhường xe cho nhiệm vụ khác',
  WITHDRAWN_EXTERNALLY: 'Lệnh bị rút từ bên ngoài WES',
  LOST: 'Lệnh không còn trên hệ thống điều khiển (kernel khởi động lại?)',
};

@Injectable()
export class DirectTaskSaga {
  private readonly logger = new Logger(DirectTaskSaga.name);
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly transportTask: TransportTaskService,
  ) {}

  @OnEvent(TASK_ORDER_EVENTS.ENDED)
  onTaskOrder(event: TaskOrderEndedEvent): Promise<void> {
    const previous = this.queues.get(event.taskId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(event))
      .catch((err: unknown) =>
        this.logger.error(
          `Task ${event.taskId}: ${event.outcome} of ${event.orderName} failed — ${(err as Error).message}`,
        ),
      )
      .finally(() => {
        if (this.queues.get(event.taskId) === next) {
          this.queues.delete(event.taskId);
        }
      });
    this.queues.set(event.taskId, next);
    return next;
  }

  private async handle(event: TaskOrderEndedEvent): Promise<void> {
    const task = await this.taskRepo.findOne({ where: { id: event.taskId } });
    if (!task || task.kind === TaskKind.CARGO) return;

    if (event.outcome === 'STARTED') {
      await this.markStarted(task, event.vehicleName);
      return;
    }

    if (task.kind !== TaskKind.PARK && RECREATED_OUTCOMES.has(event.outcome)) {
      return;
    }

    const to = OUTCOME_STATUS[event.outcome];
    if (!TransportTaskStateMachine.canTransition(task.status, to, task.kind)) {
      return;
    }
    const now = new Date();
    if (to === TaskStatus.COMPLETED) task.completedAt = now;
    if (to === TaskStatus.CANCELLED) task.cancelledAt = now;
    await this.transportTask.changeStatus(task, to, {
      trigger: 'SAGA',
      vehicleName: event.vehicleName,
      reason: OUTCOME_REASON[event.outcome] ?? null,
      context: { orderName: event.orderName },
    });
    this.logger.log(
      `${task.kind} task ${task.requestCode} → ${to} (${event.orderName} ${event.outcome})`,
    );
  }

  private async markStarted(
    task: TransportTaskEntity,
    vehicleName: string | null,
  ): Promise<void> {
    if (vehicleName && task.metadata?.assignedVehicleName !== vehicleName) {
      task.metadata = { ...task.metadata, assignedVehicleName: vehicleName };
      task.assignedAt ??= new Date();
    }
    if (task.status !== TaskStatus.CREATED) {
      await this.taskRepo.save(task);
      this.transportTask.publishUpdated(task);
      return;
    }
    task.startedAt = new Date();
    await this.transportTask.changeStatus(task, TaskStatus.EXECUTING, {
      trigger: 'SAGA',
      vehicleName,
    });
  }
}
