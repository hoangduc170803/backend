import { Injectable, Logger } from '@nestjs/common';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ORDER_KIND } from '../opentcs/domain/transport-order';
import { TransportTaskService } from './transport-task.service';
import { CargoEntity } from './entities/cargo.entity';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import type { DispatchMeasurement } from './assignment-engine.types';

@Injectable()
export class PickupOrderService {
  private readonly logger = new Logger(PickupOrderService.name);

  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly transportOrders: TransportOrderService,
    private readonly transportTask: TransportTaskService,
  ) {}

  async issue(
    task: TransportTaskEntity,
    cargo: CargoEntity | null,
    mapRecordId: string,
    vehicleName: string,
    distanceToSource: number | null,
    measurement: DispatchMeasurement,
  ): Promise<boolean> {
    if (!cargo?.sourcePickupLocationName) {
      this.logger.warn(`Task ${task.id} missing pickup location — skipping`);
      return false;
    }
    if (task.mapRecordId !== mapRecordId || cargo.mapRecordId !== mapRecordId) {
      this.logger.error(
        `Task ${task.id} (map ${task.mapRecordId ?? 'none'}, cargo map ${cargo.mapRecordId ?? 'none'}) is not on the loaded map ${mapRecordId} — refusing to issue its pick-up order`,
      );
      return false;
    }

    let pickupOrderName: string;
    try {
      pickupOrderName = await this.transportOrders.issue({
        kind: ORDER_KIND.PICKUP,
        vehicleName,
        aimedAt: cargo.sourcePickupLocationName,
        destinations: [
          {
            locationName: cargo.sourcePickupLocationName,
            operation: this.kernelApi.loadOperation,
          },
        ],
        taskId: task.id,
        // A task gets exactly one PICKUP order, ever (never re-aimed/reissued like APPROACH or
        // DROPOFF) — safe to key it on the task id, so a retry after a lost response reaches the
        // same kernel order instead of creating a second, duplicate pickup for the same task.
        idempotencyKey: task.id,
      });
    } catch (err) {
      this.logger.error(
        `Failed to create the pick-up order for task ${task.id}: ${(err as Error).message}`,
      );
      return false;
    }

    task.assignedAt = new Date();
    task.startedAt = new Date();
    task.metadata = {
      ...task.metadata,
      assignedVehicleName: vehicleName,
      pickupOrderName,
    };
    await this.transportTask.changeStatus(task, TaskStatus.PICKING_UP, {
      trigger: 'ASSIGNMENT_ENGINE',
      vehicleName,
      context: { pickupOrderName, distanceToSource, ...measurement },
    });
    this.logger.log(
      `Task ${task.id} → PICKING_UP on ${vehicleName} (${pickupOrderName})`,
    );
    return true;
  }
}
