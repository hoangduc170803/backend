import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TransportTaskEntity,
  TaskKind,
  TaskStatus,
} from './entities/transport-task.entity';
import { TransportTaskService } from './transport-task.service';
import { PickupDependencyService } from './pickup-dependency.service';

@Injectable()
export class ReleaseEngineService {
  private readonly logger = new Logger(ReleaseEngineService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly transportTask: TransportTaskService,
    private readonly pickupDependency: PickupDependencyService,
  ) {}

  async run(): Promise<void> {
    const decisions = await this.pickupDependency.evaluate();
    this.logger.debug(
      `ReleaseEngine: ${decisions.length} at-source task(s) → ` +
        decisions
          .map(
            (d) =>
              `${d.task.id.slice(0, 8)}:${d.task.status}:${d.blocked ? 'BLOCKED' : 'OK'}`,
          )
          .join(', '),
    );
    for (const { task, blocked, reason } of decisions) {
      if ((task.kind ?? TaskKind.CARGO) !== TaskKind.CARGO) continue;
      // One bad task must not abort the whole dispatch flush.
      try {
        if (blocked) {
          await this.block(task, reason);
        } else {
          await this.unblock(task);
        }
      } catch (err) {
        this.logger.warn(
          `ReleaseEngine: skip task ${task.id} (${task.status}): ${(err as Error).message}`,
        );
      }
    }
  }

  private async block(
    task: TransportTaskEntity,
    reason: string | null,
  ): Promise<void> {
    switch (task.status) {
      case TaskStatus.CREATED:
      case TaskStatus.READY_TO_ASSIGN:
        task.metadata = {
          ...task.metadata,
          blockedReason: reason ?? undefined,
        };
        await this.transportTask.changeStatus(task, TaskStatus.BLOCKED, {
          trigger: 'RELEASE_ENGINE',
          reason,
        });
        this.logger.log(`Task ${task.id} → BLOCKED (${reason})`);
        break;
      case TaskStatus.BLOCKED:
        if ((task.metadata?.blockedReason ?? null) !== (reason ?? null)) {
          task.metadata = {
            ...task.metadata,
            blockedReason: reason ?? undefined,
          };
          await this.taskRepo.save(task);
        }
        break;
      default:
        break;
    }
  }

  private async unblock(task: TransportTaskEntity): Promise<void> {
    if (
      task.status !== TaskStatus.CREATED &&
      task.status !== TaskStatus.BLOCKED
    ) {
      return;
    }
    if (task.metadata?.blockedReason) {
      task.metadata = { ...task.metadata, blockedReason: undefined };
    }
    await this.transportTask.changeStatus(task, TaskStatus.READY_TO_ASSIGN, {
      trigger: 'RELEASE_ENGINE',
    });
  }
}
