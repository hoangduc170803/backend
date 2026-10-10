import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { CargoEntity } from './entities/cargo.entity';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { TransportTaskStateMachine } from './domain/transport-task.state-machine';
import { newRequestCode } from './domain/request-code';
import { TaskTerminationService } from './task-termination.service';
import {
  TransportTaskService,
  type StatusChangeLog,
} from './transport-task.service';
import { LoadHandlingGuard } from './load-handling.guard';
import type { TaskCancelResponse, TaskCancelResultDto } from './cargo.dto';

export interface CancelPermissions {
  readonly cargo: boolean;
  readonly direct: boolean;
}

export interface CancelContext {
  readonly permissions: CancelPermissions;
  readonly mapIds?: string[];
  readonly log?: StatusChangeLog;
  readonly loadConfirmedOffBoard?: boolean;
}

const VEHICLE_WORK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.PICKING_UP,
  TaskStatus.DELIVERING,
  TaskStatus.CREATED,
  TaskStatus.EXECUTING,
];

const OPERATOR_LOG: StatusChangeLog = {
  trigger: 'API',
  reason: 'cancelled by operator',
};

function failure(taskId: string, reason: string): TaskCancelResultDto {
  return { taskId, outcome: 'failed', reason, replacementTaskId: null };
}

function isInMapScope(
  mapRecordId: string | null,
  mapIds: string[] | undefined,
): boolean {
  return (
    mapIds === undefined || (!!mapRecordId && mapIds.includes(mapRecordId))
  );
}

@Injectable()
export class TaskCancellationService {
  private readonly logger = new Logger(TaskCancellationService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    private readonly taskTermination: TaskTerminationService,
    private readonly transportTask: TransportTaskService,
    private readonly loadHandling: LoadHandlingGuard,
    private readonly activeMap: ActiveMapContext,
    private readonly kernelApi: KernelApiService,
    private readonly vehicleStore: VehicleStateStore,
  ) {}

  async cancelTasks(
    ids: readonly string[],
    context: CancelContext,
  ): Promise<TaskCancelResponse> {
    const loadedMapId = await this.activeMap.id();
    const uniqueIds = [...new Set(ids)];
    const tasks = uniqueIds.length
      ? await this.taskRepo.find({ where: { id: In(uniqueIds) } })
      : [];
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const results: TaskCancelResultDto[] = [];
    for (const taskId of uniqueIds) {
      results.push(
        await this.cancelFound(
          taskId,
          taskById.get(taskId) ?? null,
          loadedMapId,
          context,
        ),
      );
    }
    return { results };
  }

  async cancelVehicleWork(
    vehicleName: string,
    context: CancelContext,
  ): Promise<TaskCancelResultDto | null> {
    const loadedMapId = await this.activeMap.id();
    const task = loadedMapId
      ? await this.activeTaskOf(vehicleName, loadedMapId)
      : null;
    if (task) return this.cancel(task, loadedMapId, context);

    if (this.vehicleStore.get(vehicleName)?.transportOrder) {
      await this.kernelApi.withdrawVehicleOrder(vehicleName, false);
    }
    return null;
  }

  activeTaskOf(
    vehicleName: string,
    mapRecordId: string,
  ): Promise<TransportTaskEntity | null> {
    return this.taskRepo
      .createQueryBuilder('task')
      .where('task.map_record_id = :mapRecordId', { mapRecordId })
      .andWhere('task.status IN (:...statuses)', {
        statuses: VEHICLE_WORK_STATUSES,
      })
      .andWhere(`task.metadata->>'assignedVehicleName' = :vehicleName`, {
        vehicleName,
      })
      .orderBy('task.created_at', 'DESC')
      .getOne();
  }

  private async cancelFound(
    taskId: string,
    task: TransportTaskEntity | null,
    loadedMapId: string | null,
    context: CancelContext,
  ): Promise<TaskCancelResultDto> {
    if (!task || !isInMapScope(task.mapRecordId, context.mapIds)) {
      return failure(taskId, 'Không tìm thấy nhiệm vụ.');
    }
    return this.cancel(task, loadedMapId, context);
  }

  private async cancel(
    task: TransportTaskEntity,
    loadedMapId: string | null,
    context: CancelContext,
  ): Promise<TaskCancelResultDto> {
    if (task.status === TaskStatus.CANCELLED) {
      return {
        taskId: task.id,
        outcome: 'unchanged',
        reason: null,
        replacementTaskId: null,
      };
    }
    if (TransportTaskStateMachine.isTerminal(task.status, task.kind)) {
      return failure(task.id, 'Nhiệm vụ đã kết thúc.');
    }

    const isCargo = task.kind === TaskKind.CARGO;
    if (isCargo && !context.permissions.cargo) {
      return failure(
        task.id,
        'Không có quyền huỷ nhiệm vụ hàng (cargo.cancel).',
      );
    }
    if (!isCargo && !context.permissions.direct) {
      return failure(task.id, 'Không có quyền huỷ nhiệm vụ (task.cancel).');
    }
    if (isCargo && task.status === TaskStatus.DELIVERING) {
      return failure(
        task.id,
        'Hàng đã lên xe — không thể huỷ nhiệm vụ đang giao.',
      );
    }

    const onLoadedMap = !!loadedMapId && task.mapRecordId === loadedMapId;
    const log = context.log ?? OPERATOR_LOG;
    try {
      if (!isCargo) {
        await this.terminate(task, log, onLoadedMap);
        return {
          taskId: task.id,
          outcome: 'cancelled',
          reason: null,
          replacementTaskId: null,
        };
      }
      const replacement = await this.cancelAndRequeueCargoTask(
        task,
        log,
        onLoadedMap && !context.loadConfirmedOffBoard,
      );
      return {
        taskId: task.id,
        outcome: 'cancelled',
        reason: null,
        replacementTaskId: replacement?.id ?? null,
      };
    } catch (err) {
      return failure(task.id, (err as Error).message);
    }
  }

  private async cancelAndRequeueCargoTask(
    task: TransportTaskEntity,
    log: StatusChangeLog,
    guardLoadHandling: boolean,
  ): Promise<TransportTaskEntity | null> {
    const cargo = task.cargoId
      ? await this.cargoRepo.findOne({ where: { id: task.cargoId } })
      : null;
    if (cargo && guardLoadHandling) {
      await this.loadHandling.assertVehicleIsNotHandlingTheLoad(task, cargo);
    }
    const onLoadedMap = await this.isOnLoadedMap(task);
    await this.terminate(task, log, onLoadedMap);
    if (!cargo) return null;

    const replacement = await this.taskRepo.save(
      this.taskRepo.create({
        requestCode: newRequestCode(TaskKind.CARGO),
        kind: TaskKind.CARGO,
        cargoId: cargo.id,
        mapRecordId: task.mapRecordId,
        status: TaskStatus.CREATED,
        metadata: {},
      }),
    );
    this.transportTask.publishCreated(replacement, log.trigger);
    this.logger.log(
      `Task ${task.requestCode} cancelled — cargo ${cargo.itemCode} back to dispatch as ${replacement.requestCode}`,
    );
    return replacement;
  }

  private async isOnLoadedMap(task: TransportTaskEntity): Promise<boolean> {
    const loadedMapId = await this.activeMap.id();
    return !!loadedMapId && task.mapRecordId === loadedMapId;
  }

  private async terminate(
    task: TransportTaskEntity,
    log: StatusChangeLog,
    onLoadedMap: boolean,
  ): Promise<void> {
    task.cancelledAt = new Date();
    task.metadata = {
      ...task.metadata,
      cancelReason: log.reason ?? undefined,
    };
    await this.taskTermination.terminate(task, TaskStatus.CANCELLED, log, {
      onLoadedMap,
    });
    this.transportTask.publishUpdated(task);
  }
}
