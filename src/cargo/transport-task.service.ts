import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { TaskStatusTransitionEntity } from './entities/task-status-transition.entity';
import { TransportTaskStateMachine } from './domain/transport-task.state-machine';
import {
  TRANSPORT_TASK_EVENTS,
  TransportTaskCreatedEvent,
  TransportTaskStatusChangedEvent,
  TransportTaskCompletedEvent,
  TransportTaskFailedEvent,
  TransportTaskUpdatedEvent,
} from './domain/events';

export interface StatusChangeLog {
  trigger?:
    | 'API'
    | 'CARGO_CREATE'
    | 'RELEASE_ENGINE'
    | 'ASSIGNMENT_ENGINE'
    | 'SAGA'
    | 'LEG_RECONCILE'
    | 'PARKING_ENGINE'
    | 'CHARGE_ENGINE'
    | 'DISCONNECT_WATCHER'
    | 'ORDER_RECREATION';
  reason?: string | null;
  vehicleName?: string | null;
  context?: Record<string, unknown>;
}

@Injectable()
export class TransportTaskService {
  private readonly logger = new Logger(TransportTaskService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(TaskStatusTransitionEntity)
    private readonly transitionRepo: Repository<TaskStatusTransitionEntity>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  publishCreated(
    task: TransportTaskEntity,
    trigger: StatusChangeLog['trigger'] = 'API',
  ): void {
    this.logger.debug(
      `publishCreated: emitting ${TRANSPORT_TASK_EVENTS.CREATED} for task ${task.id}`,
    );
    void this.recordTransition(task, null, task.status, { trigger });
    this.eventEmitter.emit(
      TRANSPORT_TASK_EVENTS.CREATED,
      new TransportTaskCreatedEvent(task.id, task.cargoId),
    );
  }

  /** Metadata-only change (no status transition) that other clients still need to see. */
  publishUpdated(task: TransportTaskEntity): void {
    this.eventEmitter.emit(
      TRANSPORT_TASK_EVENTS.UPDATED,
      new TransportTaskUpdatedEvent(task.id, task.cargoId),
    );
  }

  async changeStatus(
    task: TransportTaskEntity,
    to: TaskStatus,
    log?: StatusChangeLog,
  ): Promise<TransportTaskEntity> {
    const from = task.status;
    TransportTaskStateMachine.transition(task, to);
    const saved = await this.taskRepo.save(task);
    await this.recordTransition(saved, from, to, log);

    this.eventEmitter.emit(
      TRANSPORT_TASK_EVENTS.STATUS_CHANGED,
      new TransportTaskStatusChangedEvent(saved.id, from, to, saved.cargoId),
    );

    if (to === TaskStatus.DELIVERY_COMPLETED) {
      this.eventEmitter.emit(
        TRANSPORT_TASK_EVENTS.COMPLETED,
        new TransportTaskCompletedEvent(saved.id, saved.cargoId),
      );
    } else if (to === TaskStatus.FAILED) {
      this.eventEmitter.emit(
        TRANSPORT_TASK_EVENTS.FAILED,
        new TransportTaskFailedEvent(saved.id, saved.cargoId),
      );
    }

    return saved;
  }
  private async recordTransition(
    task: TransportTaskEntity,
    from: TaskStatus | null,
    to: TaskStatus,
    log?: StatusChangeLog,
  ): Promise<void> {
    try {
      await this.transitionRepo.save(
        this.transitionRepo.create({
          taskId: task.id,
          fromStatus: from,
          toStatus: to,
          trigger: log?.trigger ?? null,
          vehicleName:
            log?.vehicleName !== undefined
              ? log.vehicleName
              : (task.metadata?.assignedVehicleName ?? null),
          reason: log?.reason ?? null,
          context: log?.context ?? {},
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to record transition ${from ?? 'NULL'}→${to} for task ${task.id}: ${(err as Error).message}`,
      );
    }
  }
}
