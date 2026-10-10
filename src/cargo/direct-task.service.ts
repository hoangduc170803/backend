import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ORDER_KIND, type OrderKind } from '../opentcs/domain/transport-order';
import type { TransportOrderDestination } from '../opentcs/domain/kernel-model';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
  type PendingTaskOrder,
  type TaskMetadata,
} from './entities/transport-task.entity';
import { KernelSessionService } from '../kernel-session/kernel-session.service';
import { TransportTaskService } from './transport-task.service';
import { newRequestCode } from './domain/request-code';
import { ParkYieldService } from './park-yield.service';
import { WorkEnergyGuard } from './work-energy.guard';

export type DirectTaskKind = TaskKind.MANUAL | TaskKind.PARK | TaskKind.CHARGE;

export interface DirectTaskRequest {
  readonly kind: DirectTaskKind;
  readonly vehicleName: string | null;
  readonly aimedAt: string;
  readonly destinations: readonly TransportOrderDestination[];
  readonly dispensable?: boolean;
  readonly type?: string;
  readonly trigger: 'API' | 'PARKING_ENGINE' | 'CHARGE_ENGINE';
}

export interface DirectTaskCreated {
  readonly task: TransportTaskEntity;
  readonly orderName: string | null;
}

const ORDER_KIND_OF: Readonly<Record<DirectTaskKind, OrderKind>> = {
  [TaskKind.MANUAL]: ORDER_KIND.MANUAL,
  [TaskKind.PARK]: ORDER_KIND.PARK,
  [TaskKind.CHARGE]: ORDER_KIND.CHARGE,
};

@Injectable()
export class DirectTaskService {
  private readonly logger = new Logger(DirectTaskService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly transportOrders: TransportOrderService,
    private readonly transportTask: TransportTaskService,
    private readonly activeMap: ActiveMapContext,
    private readonly parkYield: ParkYieldService,
    private readonly workEnergy: WorkEnergyGuard,
    private readonly kernelSession: KernelSessionService,
  ) {}

  async create(request: DirectTaskRequest): Promise<DirectTaskCreated> {
    if (request.destinations.length === 0) {
      throw new BadRequestException('Cần ít nhất 1 điểm đến.');
    }
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) {
      throw new ServiceUnavailableException(
        'Không xác định được bản đồ đang tải trên hệ thống điều khiển.',
      );
    }

    if (request.kind === TaskKind.MANUAL && request.vehicleName) {
      await this.workEnergy.assertCanTakeNewWork(
        request.vehicleName,
        mapRecordId,
      );
    }

    const task = await this.taskRepo.save(
      this.taskRepo.create({
        requestCode: newRequestCode(request.kind),
        kind: request.kind,
        cargoId: null,
        mapRecordId,
        status: TaskStatus.CREATED,
        metadata: request.vehicleName
          ? { assignedVehicleName: request.vehicleName }
          : {},
        assignedAt: request.vehicleName ? new Date() : null,
      }),
    );
    this.transportTask.publishCreated(task, request.trigger);

    const pending = pendingOrderOf(request);
    if (!this.kernelSession.isReady()) {
      task.metadata = { ...task.metadata, pendingOrder: pending };
      await this.taskRepo.save(task);
      this.logger.log(
        `${request.kind} task ${task.requestCode} queued — the kernel is not ready, its order is issued once it is restored`,
      );
      return { task, orderName: null };
    }

    if (request.vehicleName && request.kind !== TaskKind.PARK) {
      await this.parkYield.yieldVehicle(request.vehicleName, mapRecordId);
    }
    try {
      const orderName = await this.issueOrder(task.id, pending);
      return { task, orderName };
    } catch (err) {
      await this.transportTask.changeStatus(task, TaskStatus.FAILED, {
        trigger: request.trigger,
        vehicleName: request.vehicleName,
        reason: `Không tạo được lệnh: ${(err as Error).message}`,
      });
      this.logger.warn(
        `${request.kind} task ${task.requestCode} could not issue its order: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async issuePending(task: TransportTaskEntity): Promise<string | null> {
    const pending = task.metadata?.pendingOrder;
    if (!pending) return null;
    if (
      pending.vehicleName &&
      task.kind !== TaskKind.PARK &&
      task.mapRecordId
    ) {
      await this.parkYield.yieldVehicle(pending.vehicleName, task.mapRecordId);
    }
    const orderName = await this.issueOrder(task.id, pending);
    task.metadata = withoutPendingOrder(task.metadata);
    await this.taskRepo.save(task);
    return orderName;
  }

  private issueOrder(
    taskId: string,
    pending: PendingTaskOrder,
  ): Promise<string> {
    return this.transportOrders.issue({
      kind: pending.kind as OrderKind,
      vehicleName: pending.vehicleName,
      aimedAt: pending.aimedAt,
      destinations: pending.destinations,
      taskId,
      dispensable: pending.dispensable,
      type: pending.type,
    });
  }
}

function pendingOrderOf(request: DirectTaskRequest): PendingTaskOrder {
  return {
    kind: ORDER_KIND_OF[request.kind],
    vehicleName: request.vehicleName,
    aimedAt: request.aimedAt,
    destinations: request.destinations.map((destination) => ({
      locationName: destination.locationName,
      operation: destination.operation,
    })),
    dispensable: request.dispensable,
    type: request.type,
  };
}

function withoutPendingOrder(metadata: TaskMetadata): TaskMetadata {
  const next = { ...metadata };
  delete next.pendingOrder;
  return next;
}
