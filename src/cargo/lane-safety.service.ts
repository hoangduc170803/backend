import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { TransportTaskService } from './transport-task.service';
import { TaskOrderService } from './task-order.service';
import { ZoneGeometryService, MemberAxes } from './zone-geometry.service';
import {
  allocationReachesPoints,
  isDeeperInSameLane,
  LaneSlot,
} from './domain/lane-safety.policy';

export interface DeeperPickup {
  task: TransportTaskEntity;
  cargo: CargoEntity;
}

@Injectable()
export class LaneSafetyService {
  private readonly logger = new Logger(LaneSafetyService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly zoneGeometry: ZoneGeometryService,
    private readonly kernelApi: KernelApiService,
    private readonly transportOrders: TransportOrderService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly transportTask: TransportTaskService,
    private readonly taskOrders: TaskOrderService,
  ) {}

  async clearLaneForNewCargo(
    sourceZoneId: string,
    pickupLocationName: string,
  ): Promise<void> {
    const { deeperPickups, committed } = await this.inspectLane(
      sourceZoneId,
      pickupLocationName,
    );

    const blocker = deeperPickups.find(({ task }) => committed.has(task.id));
    if (blocker) {
      throw new BadRequestException(
        `Không đủ an toàn để tạo hàng tại vị trí này: xe ${blocker.task.metadata?.assignedVehicleName} đã được lệnh vào dãy này để lấy hàng tại ${blocker.cargo.sourcePointName ?? blocker.cargo.sourcePickupLocationName}.`,
      );
    }

    for (const { task } of deeperPickups) {
      await this.preempt(task, pickupLocationName);
    }
  }

  async findCommittedPickupInLane(
    sourceZoneId: string,
    pickupLocationName: string,
  ): Promise<DeeperPickup | null> {
    const { deeperPickups, committed } = await this.inspectLane(
      sourceZoneId,
      pickupLocationName,
    );
    return deeperPickups.find(({ task }) => committed.has(task.id)) ?? null;
  }

  private async inspectLane(
    sourceZoneId: string,
    pickupLocationName: string,
  ): Promise<{ deeperPickups: DeeperPickup[]; committed: Set<string> }> {
    const nothingInLane = { deeperPickups: [], committed: new Set<string>() };

    const zone = await this.zoneRepo.findOne({ where: { id: sourceZoneId } });
    if (!zone) return nothingInLane;

    const laneIndex = await this.zoneGeometry.laneIndexOf(zone);
    const newSlot = laneIndex?.axesByLocation.get(pickupLocationName);
    if (!laneIndex || !newSlot) return nothingInLane;

    const deeperPickups = await this.findDeeperPickups(
      sourceZoneId,
      newSlot,
      laneIndex.axesByLocation,
    );
    if (deeperPickups.length === 0) return nothingInLane;

    const committed = await this.committedInsideLane(
      deeperPickups.map((pickup) => pickup.task),
    );
    return { deeperPickups, committed };
  }

  async committedInsideLane(
    tasks: readonly TransportTaskEntity[],
  ): Promise<Set<string>> {
    const committed = new Set<string>();
    if (tasks.length === 0) return committed;

    const cargoById = await this.cargoesOf(tasks);
    const allocatedByVehicle = await this.readAllocatedResources(
      vehicleNamesOf(tasks),
    );

    const byZone = new Map<string, DeeperPickup[]>();
    for (const task of tasks) {
      const cargo = task.cargoId ? cargoById.get(task.cargoId) : undefined;
      if (!task.metadata?.assignedVehicleName) continue;
      if (!cargo?.sourceZoneId || !cargo.sourcePickupLocationName) continue;
      const entries = byZone.get(cargo.sourceZoneId) ?? [];
      entries.push({ task, cargo });
      byZone.set(cargo.sourceZoneId, entries);
    }

    const zones = byZone.size
      ? await this.zoneRepo.find({ where: { id: In([...byZone.keys()]) } })
      : [];
    const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
    for (const [zoneId, entries] of byZone) {
      const zone = zoneById.get(zoneId);
      const laneIndex = zone ? await this.zoneGeometry.laneIndexOf(zone) : null;
      if (!laneIndex) continue;

      for (const { task, cargo } of entries) {
        const slot = laneIndex.axesByLocation.get(
          cargo.sourcePickupLocationName as string,
        );
        if (!slot) continue;
        const lanePoints =
          laneIndex.pointsByLane.get(slot.laneKey) ?? new Set<string>();
        const allocated =
          allocatedByVehicle.get(
            task.metadata?.assignedVehicleName as string,
          ) ?? [];
        if (allocationReachesPoints(allocated, lanePoints)) {
          committed.add(task.id);
        }
      }
    }
    return committed;
  }

  private async cargoesOf(
    tasks: readonly TransportTaskEntity[],
  ): Promise<Map<string, CargoEntity>> {
    const cargoIds = tasks.reduce<string[]>((ids, task) => {
      if (task.cargoId !== null) ids.push(task.cargoId);
      return ids;
    }, []);
    if (cargoIds.length === 0) return new Map();
    const cargos = await this.cargoRepo.find({ where: { id: In(cargoIds) } });
    return new Map(cargos.map((cargo) => [cargo.id, cargo]));
  }

  private async preempt(
    task: TransportTaskEntity,
    newCargoLocationName: string,
  ): Promise<void> {
    const pickupOrderName =
      (await this.taskOrders.latestActiveOrder(task.id, 'PICKUP'))?.orderName ??
      task.metadata?.pickupOrderName;
    const vehicleName = task.metadata?.assignedVehicleName ?? null;
    const reason = `Preempted by new cargo at ${newCargoLocationName} (closer to the aisle in the same lane)`;

    if (pickupOrderName) {
      await this.transportOrders.cancel(pickupOrderName);
    }

    task.metadata = {
      ...task.metadata,
      blockedReason: reason,
      pickupOrderName: undefined,
      assignedVehicleName: undefined,
    };
    task.assignedAt = null;
    task.startedAt = null;
    await this.transportTask.changeStatus(task, TaskStatus.BLOCKED, {
      trigger: 'CARGO_CREATE',
      reason,
      vehicleName,
      context: { preempted: true, withdrawnOrder: pickupOrderName ?? null },
    });
    this.logger.log(`Task ${task.id} PREEMPTED → BLOCKED (${reason})`);
  }

  private async findDeeperPickups(
    sourceZoneId: string,
    newSlot: LaneSlot,
    axesByLocation: Map<string, MemberAxes>,
  ): Promise<DeeperPickup[]> {
    const cargos = await this.cargoRepo.find({
      where: { sourceZoneId, status: CargoStatus.ACTIVE },
    });

    const deeperCargoById = new Map<string, CargoEntity>();
    for (const cargo of cargos) {
      const slot = cargo.sourcePickupLocationName
        ? axesByLocation.get(cargo.sourcePickupLocationName)
        : undefined;
      if (slot && isDeeperInSameLane(slot, newSlot)) {
        deeperCargoById.set(cargo.id, cargo);
      }
    }
    if (deeperCargoById.size === 0) return [];

    const tasks = await this.taskRepo.find({
      where: {
        cargoId: In([...deeperCargoById.keys()]),
        status: TaskStatus.PICKING_UP,
      },
    });

    return tasks.flatMap((task) => {
      const cargo = task.cargoId
        ? deeperCargoById.get(task.cargoId)
        : undefined;
      return cargo ? [{ task, cargo }] : [];
    });
  }

  private async readAllocatedResources(
    vehicleNames: readonly string[],
  ): Promise<Map<string, string[][]>> {
    if (!this.vehicleStore.isConnected()) {
      const states = await this.kernelApi.getVehicleStates();
      return new Map(
        states.map((state) => [state.name, state.allocatedResources ?? []]),
      );
    }
    return new Map(
      vehicleNames.map((name) => [
        name,
        this.vehicleStore.get(name)?.allocatedResources ?? [],
      ]),
    );
  }
}

function vehicleNamesOf(tasks: readonly TransportTaskEntity[]): string[] {
  return tasks.reduce<string[]>((names, task) => {
    const name = task.metadata?.assignedVehicleName;
    if (typeof name === 'string') names.push(name);
    return names;
  }, []);
}
