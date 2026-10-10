import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  TaskKind,
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { AgvEntity } from '../agvs/entities/agv.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { DirectTaskService } from './direct-task.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { ParkClaimStore } from './park-claim.store';
import { RoutingService } from './routing.service';
import { shortestDistancesFrom } from './domain/routing';
import { activeCargoVehicleNames } from './task-queries';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { ChargeSlotReservationStore } from './charge-slot-reservation.store';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { DeliverySlotEngine } from './delivery-slot.engine';
import {
  ParkingPoint,
  ParkVehicleCandidate,
  mustClearChargePoint,
  mustLeaveZone,
  needsParking,
  pickParkingPoint,
  unavailableParkPoints,
} from './domain/parking.policy';

const PENDING_WORK_STATUSES = [TaskStatus.READY_TO_ASSIGN];

function isIdleAvailable(state: KernelVehicleState | undefined): boolean {
  if (!state) return false;
  return (
    (state.procState === 'IDLE' || state.procState === 'AWAITING_ORDER') &&
    state.integrationLevel === 'TO_BE_UTILIZED'
  );
}

@Injectable()
export class ParkingEngineService {
  private readonly logger = new Logger(ParkingEngineService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(AgvEntity)
    private readonly agvRepo: Repository<AgvEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly directTasks: DirectTaskService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly routing: RoutingService,
    private readonly parkClaims: ParkClaimStore,
    private readonly activeMap: ActiveMapContext,
    private readonly chargeSlotReservations: ChargeSlotReservationStore,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly deliverySlotEngine: DeliverySlotEngine,
  ) {}

  async run(): Promise<void> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return;
    const parkingPoints = await this.parkPool();
    if (parkingPoints.length === 0) return;
    const parkPointNames = new Set(parkingPoints.map((p) => p.name));

    const hasPendingWork = await this.hasPendingWork(mapRecordId);
    const busy = await activeCargoVehicleNames(this.taskRepo, mapRecordId);
    const agvs = await this.agvRepo.find({ where: { mapRecordId } });

    const readyToPark: Array<{
      name: string;
      position: string;
      reason: string;
    }> = [];
    const reservedChargePoints = this.chargeSlotReservations.reservedPoints();
    const zonePoints = await this.zonePointsOf(mapRecordId);

    for (const agv of agvs) {
      const fms = this.vehicleStore.get(agv.name);
      const candidate = this.toCandidate(agv, fms, busy);
      const reason = parkReason(
        candidate,
        parkPointNames,
        hasPendingWork,
        reservedChargePoints,
        zonePoints,
      );
      if (!reason || !candidate.currentPosition) continue;
      readyToPark.push({
        name: agv.name,
        position: candidate.currentPosition,
        reason,
      });
    }

    if (readyToPark.length === 0) return;

    if (!this.parkClaims.isReady()) {
      this.logger.warn(
        'Park claims not rehydrated from the kernel — skipping this park pass',
      );
      return;
    }

    const claimedVehicles = this.parkClaims.claimedVehicles();
    const unclaimed: typeof readyToPark = [];
    for (const vehicle of readyToPark) {
      if (claimedVehicles.has(vehicle.name)) {
        this.logger.log(
          `${vehicle.name} already has a live park order — keeping its target`,
        );
        continue;
      }
      unclaimed.push(vehicle);
    }

    const graph = await this.routing.getRoadGraph();
    const excluded = unavailableParkPoints(
      this.vehicleStore.getAll(),
      parkPointNames,
    );
    const claimedPoints = this.parkClaims.claimedPoints();
    for (const point of claimedPoints) excluded.add(point);
    this.logParkDecisionInput(unclaimed, claimedVehicles, claimedPoints);

    for (const { name, position, reason } of unclaimed) {
      const distances = graph
        ? shortestDistancesFrom(graph, position)
        : new Map<string, number>();
      const point = pickParkingPoint(parkingPoints, distances, excluded);
      if (!point) {
        this.logger.debug(
          `No free park point reachable for ${name} — skipping`,
        );
        continue;
      }
      excluded.add(point.name);
      await this.createParkOrder(name, point.name, reason);
    }
  }

  private logParkDecisionInput(
    unclaimed: readonly { name: string }[],
    claimedVehicles: ReadonlySet<string>,
    claimedPoints: ReadonlySet<string>,
  ): void {
    this.logger.debug(
      `Park pass: ready=[${unclaimed.map((v) => v.name).join(' ')}]` +
        ` claimedVehicles=[${[...claimedVehicles].join(' ')}]` +
        ` claimedPoints=[${[...claimedPoints].join(' ')}]`,
    );
  }

  private async parkPool(): Promise<ParkingPoint[]> {
    const parkingPoints = await this.kernelApi.getParkingPoints();
    const chargeLocations = await this.kernelApi.getChargeLocations();
    const chargePoints = new Set<string>();
    for (const location of chargeLocations) {
      for (const point of location.points) chargePoints.add(point);
    }
    return parkingPoints.filter((p) => !chargePoints.has(p.name));
  }

  private toCandidate(
    agv: AgvEntity,
    fms: KernelVehicleState | undefined,
    busy: ReadonlySet<string>,
  ): ParkVehicleCandidate {
    return {
      name: agv.name,
      dispatchEnabled: agv.isDispatchEnabled,
      ignored: agv.isIgnored,
      idleAvailable: isIdleAvailable(fms),
      onOrder: fms?.transportOrder != null,
      hasActiveTask: busy.has(agv.name),
      belowCritical:
        fms != null && fms.energyLevel <= agv.criticalBatteryThreshold,
      charging: fms?.state === 'CHARGING',
      currentPosition: fms?.currentPosition ?? null,
    };
  }

  private async zonePointsOf(mapRecordId: string): Promise<Set<string>> {
    const zones = await this.zoneRepo.find({
      where: { mapRecordId },
      relations: { members: true },
    });
    const points = new Set<string>();
    for (const zone of zones) {
      for (const point of await this.deliverySlotEngine.blockingPointsOf(
        zone,
      )) {
        points.add(point);
      }
    }
    return points;
  }

  private async hasPendingWork(mapRecordId: string): Promise<boolean> {
    const count = await this.taskRepo.count({
      where: { status: In(PENDING_WORK_STATUSES), mapRecordId },
    });
    return count > 0;
  }

  private async createParkOrder(
    vehicleName: string,
    pointName: string,
    reason: string,
  ): Promise<void> {
    try {
      const { orderName } = await this.directTasks.create({
        kind: TaskKind.PARK,
        trigger: 'PARKING_ENGINE',
        vehicleName,
        aimedAt: pointName,
        destinations: [{ locationName: pointName, operation: 'MOVE' }],
        dispensable: true,
      });
      if (!orderName) return;
      this.parkClaims.claim(vehicleName, pointName, orderName);
      this.logger.log(
        `Parking ${vehicleName} → ${pointName} (${orderName}) — ${reason}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to park ${vehicleName}: ${(err as Error).message}`,
      );
    }
  }
}

function parkReason(
  candidate: ParkVehicleCandidate,
  parkPointNames: ReadonlySet<string>,
  hasPendingWork: boolean,
  reservedChargePoints: ReadonlySet<string>,
  zonePoints: ReadonlySet<string>,
): string | null {
  if (needsParking(candidate, parkPointNames, hasPendingWork)) return 'idle';
  if (mustClearChargePoint(candidate, reservedChargePoints)) {
    return 'clearing a charge point promised to a critical vehicle';
  }
  if (mustLeaveZone(candidate, zonePoints)) {
    return `idle inside a zone lane at ${candidate.currentPosition}, would block its slots`;
  }
  return null;
}
