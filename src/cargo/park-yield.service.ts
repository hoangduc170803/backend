import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { TaskTerminationService } from './task-termination.service';
import { ParkClaimStore } from './park-claim.store';
import type { StatusChangeLog } from './transport-task.service';

const LIVE_PARK_STATUSES = [TaskStatus.CREATED, TaskStatus.EXECUTING];
const YIELD_REASON = 'Nhường xe cho nhiệm vụ khác';

@Injectable()
export class ParkYieldService {
  private readonly logger = new Logger(ParkYieldService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly taskTermination: TaskTerminationService,
    private readonly parkClaims: ParkClaimStore,
  ) {}

  async yieldVehicle(vehicleName: string, mapRecordId: string): Promise<void> {
    const parkTasks = await this.liveParkTasksOf(vehicleName, mapRecordId);
    for (const task of parkTasks) {
      await this.cancel(task, vehicleName);
    }
    if (parkTasks.length > 0) this.parkClaims.release(vehicleName);
  }

  private liveParkTasksOf(
    vehicleName: string,
    mapRecordId: string,
  ): Promise<TransportTaskEntity[]> {
    return this.taskRepo
      .createQueryBuilder('task')
      .where('task.map_record_id = :mapRecordId', { mapRecordId })
      .andWhere('task.kind = :kind', { kind: TaskKind.PARK })
      .andWhere('task.status IN (:...statuses)', {
        statuses: LIVE_PARK_STATUSES,
      })
      .andWhere(`task.metadata->>'assignedVehicleName' = :vehicleName`, {
        vehicleName,
      })
      .getMany();
  }

  private async cancel(
    task: TransportTaskEntity,
    vehicleName: string,
  ): Promise<void> {
    const log: StatusChangeLog = {
      trigger: 'ASSIGNMENT_ENGINE',
      reason: YIELD_REASON,
      vehicleName,
    };
    task.cancelledAt = new Date();
    task.metadata = { ...task.metadata, cancelReason: YIELD_REASON };
    try {
      await this.taskTermination.terminate(task, TaskStatus.CANCELLED, log);
      this.logger.log(
        `${vehicleName}: park task ${task.requestCode} cancelled to take new work`,
      );
    } catch (err) {
      this.logger.warn(
        `${vehicleName}: could not cancel park task ${task.requestCode} — ${(err as Error).message}`,
      );
    }
  }
}
