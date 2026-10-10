import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { CargoEntity } from './entities/cargo.entity';
import {
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { allocationReachesPoints } from './domain/lane-safety.policy';
import { TaskOrderService } from './task-order.service';

@Injectable()
export class LoadHandlingGuard {
  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly taskOrders: TaskOrderService,
  ) {}

  async assertVehicleIsNotHandlingTheLoad(
    task: TransportTaskEntity,
    cargo: CargoEntity,
  ): Promise<void> {
    const actionPoint = await this.pointBeingHandled(task, cargo);
    if (!actionPoint) return;
    throw new BadRequestException(
      `Xe ${task.metadata?.assignedVehicleName} đang lấy/trả hàng tại ${actionPoint}. Thử lại khi thao tác kết thúc.`,
    );
  }

  private async pointBeingHandled(
    task: TransportTaskEntity,
    cargo: CargoEntity,
  ): Promise<string | null> {
    const vehicleName = task.metadata?.assignedVehicleName;
    if (!vehicleName) return null;

    const actionPoint = await this.loadActionPointOf(task, cargo);
    if (!actionPoint) return null;

    const allocated = await this.allocatedResourcesOf(vehicleName);
    return allocationReachesPoints(allocated, new Set([actionPoint]))
      ? actionPoint
      : null;
  }

  private async loadActionPointOf(
    task: TransportTaskEntity,
    cargo: CargoEntity,
  ): Promise<string | null> {
    if (task.status === TaskStatus.PICKING_UP) {
      return cargo.sourcePointName;
    }
    const dropoffOrder =
      task.status === TaskStatus.DELIVERING
        ? await this.taskOrders.latestActiveOrder(task.id, 'DROPOFF')
        : null;
    const droppingOff =
      task.status === TaskStatus.DELIVERING &&
      (!!dropoffOrder || !!task.metadata?.dropoffOrderName) &&
      !task.metadata?.unloadedAt;
    if (droppingOff && cargo.destinationLocationName) {
      return this.kernelApi.findPointForLocation(cargo.destinationLocationName);
    }
    return null;
  }

  private async allocatedResourcesOf(vehicleName: string): Promise<string[][]> {
    if (this.vehicleStore.isConnected()) {
      return this.vehicleStore.get(vehicleName)?.allocatedResources ?? [];
    }
    try {
      const states = await this.kernelApi.getVehicleStates();
      return (
        states.find((state) => state.name === vehicleName)
          ?.allocatedResources ?? []
      );
    } catch (err) {
      throw new ServiceUnavailableException(
        `Không thể xác nhận trạng thái xe ${vehicleName} — thử lại khi hệ thống điều khiển phản hồi: ${(err as Error).message}`,
      );
    }
  }
}
