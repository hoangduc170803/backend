import { OnEvent } from '@nestjs/event-emitter';
import { TASK_ORDER_EVENTS, TaskOrderReplacedEvent } from './domain/events';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AgvEntity } from '../agvs/entities/agv.entity';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { TaskOrderEntity, TaskOrderState } from './entities/task-order.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { DirectTaskService } from './direct-task.service';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { ParkClaimStore } from './park-claim.store';
import { RoutingService } from './routing.service';
import { activeCargoVehicleNames } from './task-queries';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { shortestDistancesFrom } from './domain/routing';
import { isEnRouteToPark } from './domain/vehicle-availability';
import {
  ORDER_KIND,
  destinationFromOrderName,
} from '../opentcs/domain/transport-order';
import { thresholdsOf } from '../agvs/domain/battery-thresholds';
import {
  ParkingPoint,
  pickParkingPoint,
  unavailableParkPoints,
} from './domain/parking.policy';
import {
  ChargeLocation,
  ChargeVehicleCandidate,
  needsCharging,
  wantsOpportunisticCharge,
  isReleaseCandidate,
  shouldRelease,
  pickSlotDonor,
  pickChargeLocation,
} from './domain/charge.policy';
import {
  STOP_CHARGING_ACTION,
  CHARGE_SLOT_RESERVATION_TIMEOUT_MS,
  TERMINAL_ORDER_STATES,
} from './charge-engine.constants';
import {
  ChargeSlotReservation,
  ChargeSlotReservationStore,
} from './charge-slot-reservation.store';

function isIdleAvailable(state: KernelVehicleState | undefined): boolean {
  if (!state) return false;
  return (
    (state.procState === 'IDLE' || state.procState === 'AWAITING_ORDER') &&
    state.integrationLevel === 'TO_BE_UTILIZED'
  );
}

function byEnergyAscending(
  a: ChargeVehicleCandidate,
  b: ChargeVehicleCandidate,
): number {
  return a.energyLevel - b.energyLevel || a.name.localeCompare(b.name);
}

interface ChargePass {
  readonly candidates: readonly ChargeVehicleCandidate[];
  readonly locations: readonly ChargeLocation[];
  readonly chargePoints: ReadonlySet<string>;
  readonly nonChargeParks: readonly ParkingPoint[];
  readonly parkPointNames: ReadonlySet<string>;
  readonly hasPendingWork: boolean;
  readonly issuedCharges: ReadonlyMap<string, string>;
}

@Injectable()
export class ChargeEngineService {
  private readonly logger = new Logger(ChargeEngineService.name);
  private readonly chargeTargets = new Map<
    string,
    { location: string; order: string }
  >();

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(AgvEntity)
    private readonly agvRepo: Repository<AgvEntity>,
    @InjectRepository(TaskOrderEntity)
    private readonly taskOrderRepo: Repository<TaskOrderEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly directTasks: DirectTaskService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly routing: RoutingService,
    private readonly parkClaims: ParkClaimStore,
    private readonly activeMap: ActiveMapContext,
    private readonly reservations: ChargeSlotReservationStore,
  ) {
    if (process.env.CHARGE_FULL_PCT) {
      this.logger.warn(
        'CHARGE_FULL_PCT is no longer read — charging stops at each AGV full_battery_threshold',
      );
    }
  }

  @OnEvent(TASK_ORDER_EVENTS.REPLACED)
  onOrderReplaced(event: TaskOrderReplacedEvent): void {
    for (const [vehicle, target] of this.chargeTargets) {
      if (target.order === event.oldOrderName) {
        this.chargeTargets.set(vehicle, {
          ...target,
          order: event.newOrderName,
        });
      }
    }
  }

  async run(): Promise<void> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return;
    const locations = await this.kernelApi.getChargeLocations();
    if (locations.length === 0) return;

    const chargePoints = new Set<string>();
    for (const loc of locations) {
      for (const point of loc.points) chargePoints.add(point);
    }

    await this.reconcileChargeTargets(chargePoints);

    const agvs = await this.agvRepo.find({ where: { mapRecordId } });
    const busy = await activeCargoVehicleNames(this.taskRepo, mapRecordId);
    const candidates = agvs.map((agv) =>
      this.toCandidate(agv, this.vehicleStore.get(agv.name), busy),
    );
    const parkingPoints = await this.kernelApi.getParkingPoints();
    const pass: ChargePass = {
      candidates,
      locations,
      chargePoints,
      nonChargeParks: parkingPoints.filter((p) => !chargePoints.has(p.name)),
      parkPointNames: new Set(parkingPoints.map((p) => p.name)),
      hasPendingWork: await this.hasPendingWork(mapRecordId),
      issuedCharges: await this.issuedChargeDestinations(mapRecordId),
    };

    await this.releaseCharged(candidates);
    await this.settleReservations(pass);
    await this.dispatchToCharge(pass);
  }

  private toCandidate(
    agv: AgvEntity,
    fms: KernelVehicleState | undefined,
    busy: ReadonlySet<string>,
  ): ChargeVehicleCandidate {
    return {
      name: agv.name,
      ignored: agv.isIgnored,
      dispatchEnabled: agv.isDispatchEnabled,
      idleAvailable: isIdleAvailable(fms),
      enRouteToPark: isEnRouteToPark(fms),
      charging: fms?.state === 'CHARGING',
      onOrder: fms?.transportOrder != null,
      hasActiveTask: busy.has(agv.name),
      currentPosition: fms?.currentPosition ?? null,
      energyLevel: fms?.energyLevel ?? 0,
      thresholds: thresholdsOf(agv),
    };
  }

  private async hasPendingWork(mapRecordId: string): Promise<boolean> {
    const count = await this.taskRepo.count({
      where: { status: TaskStatus.READY_TO_ASSIGN, mapRecordId },
    });
    return count > 0;
  }

  private async issuedChargeDestinations(
    mapRecordId: string,
  ): Promise<Map<string, string>> {
    const liveTasks = await this.taskRepo.find({
      where: {
        kind: TaskKind.CHARGE,
        status: In([TaskStatus.CREATED, TaskStatus.EXECUTING]),
        mapRecordId,
      },
    });
    if (liveTasks.length === 0) return new Map();
    const orders = await this.taskOrderRepo.find({
      where: {
        taskId: In(liveTasks.map((task) => task.id)),
        leg: 'CHARGE',
        state: TaskOrderState.ACTIVE,
      },
    });
    const byVehicle = new Map<string, string>();
    for (const task of liveTasks) {
      const vehicle = task.metadata?.assignedVehicleName;
      const location = orders.find((o) => o.taskId === task.id)?.destinations[0]
        ?.locationName;
      if (vehicle && location) byVehicle.set(vehicle, location);
    }
    return byVehicle;
  }

  private async releaseCharged(
    candidates: readonly ChargeVehicleCandidate[],
  ): Promise<void> {
    for (const cand of candidates) {
      if (!isReleaseCandidate(cand)) continue;
      if (!shouldRelease(cand)) continue;
      await this.stopCharging(
        cand.name,
        `full at ${cand.energyLevel}% ≥ ${cand.thresholds.full}%`,
      );
    }
  }

  async stopCharging(vehicleName: string, reason: string): Promise<boolean> {
    try {
      await this.kernelApi.sendInstantAction(vehicleName, STOP_CHARGING_ACTION);
      this.logger.log(`Released ${vehicleName} from charge (${reason})`);
      return true;
    } catch (err) {
      this.logger.warn(
        `Failed to release ${vehicleName}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async settleReservations(pass: ChargePass): Promise<void> {
    const byName = new Map(pass.candidates.map((c) => [c.name, c]));
    for (const reservation of this.reservations.all()) {
      const waiting = byName.get(reservation.forVehicle);
      const staleReason = this.staleReservationReason(reservation, waiting);
      if (staleReason) {
        this.reservations.release(reservation.forVehicle);
        this.logger.warn(
          `Charge slot ${reservation.point} reserved for ${reservation.forVehicle} dropped — ${staleReason}`,
        );
        continue;
      }
      const donorPosition = this.vehicleStore.get(
        reservation.donor,
      )?.currentPosition;
      if (donorPosition === reservation.point) continue;

      this.reservations.release(reservation.forVehicle);
      await this.createChargeOrder(
        reservation.forVehicle,
        reservation.location,
        `slot ${reservation.point} vacated by ${reservation.donor}`,
      );
    }
  }

  private staleReservationReason(
    reservation: ChargeSlotReservation,
    waiting: ChargeVehicleCandidate | undefined,
  ): string | null {
    if (!waiting || waiting.ignored) return 'vehicle no longer in the fleet';
    if (waiting.hasActiveTask) return 'vehicle took other work';
    if (Date.now() - reservation.since > CHARGE_SLOT_RESERVATION_TIMEOUT_MS) {
      return `${reservation.donor} did not leave within ${CHARGE_SLOT_RESERVATION_TIMEOUT_MS / 1000}s`;
    }
    return null;
  }

  private async dispatchToCharge(pass: ChargePass): Promise<void> {
    const eligible = pass.candidates.filter(
      (c) =>
        !this.reservations.isWaiting(c.name) &&
        !this.hasInFlightCharge(c.name, pass.chargePoints),
    );
    const critical = eligible
      .filter((c) => needsCharging(c, pass.chargePoints))
      .sort(byEnergyAscending);
    const opportunistic = eligible
      .filter((c) =>
        wantsOpportunisticCharge(c, pass.chargePoints, pass.hasPendingWork),
      )
      .sort(byEnergyAscending);
    if (critical.length === 0 && opportunistic.length === 0) return;

    const freeSlots = this.freeSlotsByLocation(pass);
    const graph = await this.routing.getRoadGraph();
    const distancesFrom = (position: string) =>
      graph
        ? shortestDistancesFrom(graph, position)
        : new Map<string, number>();
    const parkFallback = this.parkFallback(pass);

    for (const cand of critical) {
      const position = cand.currentPosition as string;
      const distances = distancesFrom(position);
      const location = pickChargeLocation(pass.locations, distances, freeSlots);
      if (location) {
        freeSlots.set(location.name, (freeSlots.get(location.name) ?? 0) - 1);
        await this.createChargeOrder(
          cand.name,
          location.name,
          `critical ${cand.energyLevel}% ≤ ${cand.thresholds.critical}%` +
            (cand.enRouteToPark ? ', park order preempted' : ''),
        );
        continue;
      }
      if (await this.reserveDonatedSlot(cand, pass)) continue;
      await parkFallback(cand, distances);
    }

    for (const cand of opportunistic) {
      const distances = distancesFrom(cand.currentPosition as string);
      const location = pickChargeLocation(pass.locations, distances, freeSlots);
      if (!location) continue;
      freeSlots.set(location.name, (freeSlots.get(location.name) ?? 0) - 1);
      await this.createChargeOrder(
        cand.name,
        location.name,
        `opportunistic ${cand.energyLevel}% < good ${cand.thresholds.good}%`,
      );
    }
  }

  private async reserveDonatedSlot(
    waiting: ChargeVehicleCandidate,
    pass: ChargePass,
  ): Promise<boolean> {
    const donors = this.reservations.donors();
    const onCharger = pass.candidates.filter(
      (c) =>
        c.currentPosition !== null &&
        pass.chargePoints.has(c.currentPosition) &&
        !donors.has(c.name),
    );
    const donor = pickSlotDonor(onCharger);
    if (!donor?.currentPosition) return false;
    const location = pass.locations.find((loc) =>
      loc.points.includes(donor.currentPosition as string),
    );
    if (!location) return false;

    const stopped = await this.stopCharging(
      donor.name,
      `yielding ${donor.currentPosition} to critical ${waiting.name} (${waiting.energyLevel}%)`,
    );
    if (!stopped) return false;
    this.reservations.reserve({
      location: location.name,
      point: donor.currentPosition,
      forVehicle: waiting.name,
      donor: donor.name,
      since: Date.now(),
    });
    this.logger.log(
      `Charge preempt: ${donor.name}(${donor.energyLevel}% ≥ sufficient ${donor.thresholds.sufficient}%) yields ${location.name}/${donor.currentPosition} to ${waiting.name}(${waiting.energyLevel}%)`,
    );
    return true;
  }

  private parkFallback(
    pass: ChargePass,
  ): (
    cand: ChargeVehicleCandidate,
    distances: ReadonlyMap<string, number>,
  ) => Promise<void> {
    const canPark = this.parkClaims.isReady();
    if (!canPark) {
      this.logger.warn(
        'Park claims not rehydrated from the kernel — charging still dispatches, the no-slot park fallback is skipped',
      );
    }
    const parkClaimedVehicles = this.parkClaims.claimedVehicles();
    const parkExcluded = unavailableParkPoints(
      this.vehicleStore.getAll(),
      new Set(pass.nonChargeParks.map((p) => p.name)),
    );
    for (const point of this.parkClaims.claimedPoints()) {
      parkExcluded.add(point);
    }

    return async (cand, distances) => {
      const position = cand.currentPosition as string;
      if (!canPark || cand.enRouteToPark) return;
      if (pass.parkPointNames.has(position)) return;
      if (parkClaimedVehicles.has(cand.name)) return;
      const point = pickParkingPoint(
        pass.nonChargeParks,
        distances,
        parkExcluded,
      );
      if (!point) {
        this.logger.debug(
          `No charge slot and no free park for ${cand.name} — waiting`,
        );
        return;
      }
      parkExcluded.add(point.name);
      await this.parkForNoSlot(cand.name, point.name);
    };
  }

  private async parkForNoSlot(
    vehicleName: string,
    pointName: string,
  ): Promise<void> {
    try {
      const { orderName } = await this.directTasks.create({
        kind: TaskKind.PARK,
        trigger: 'CHARGE_ENGINE',
        vehicleName,
        aimedAt: pointName,
        destinations: [{ locationName: pointName, operation: 'MOVE' }],
        dispensable: true,
      });
      if (!orderName) return;
      this.parkClaims.claim(vehicleName, pointName, orderName);
      this.logger.log(
        `Charge fallback park: ${vehicleName} → ${pointName} (${orderName})`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to park ${vehicleName}: ${(err as Error).message}`,
      );
    }
  }

  private freeSlotsByLocation(pass: ChargePass): Map<string, number> {
    const { locations, chargePoints } = pass;
    const occupied = new Set<string>(this.reservations.reservedPoints());
    for (const vehicle of this.vehicleStore.getAll()) {
      if (
        vehicle.currentPosition &&
        chargePoints.has(vehicle.currentPosition)
      ) {
        occupied.add(vehicle.currentPosition);
      }
    }

    const inFlight = new Map<string, number>();
    for (const location of this.chargeDestinationsInFlight(
      chargePoints,
      pass.issuedCharges,
    )) {
      inFlight.set(location, (inFlight.get(location) ?? 0) + 1);
    }

    const free = new Map<string, number>();
    for (const loc of locations) {
      const occ = loc.points.filter((point) => occupied.has(point)).length;
      free.set(
        loc.name,
        loc.points.length - occ - (inFlight.get(loc.name) ?? 0),
      );
    }
    return free;
  }

  private chargeDestinationsInFlight(
    chargePoints: ReadonlySet<string>,
    issuedCharges: ReadonlyMap<string, string>,
  ): string[] {
    const byVehicle = new Map<string, string>(issuedCharges);
    for (const [vehicleName, target] of this.chargeTargets) {
      byVehicle.set(vehicleName, target.location);
    }
    for (const state of this.vehicleStore.getAll()) {
      const location = destinationFromOrderName(
        ORDER_KIND.CHARGE,
        state.transportOrder,
        state.name,
      );
      if (location) byVehicle.set(state.name, location);
    }
    return [...byVehicle]
      .filter(([vehicleName]) => {
        const position = this.vehicleStore.get(vehicleName)?.currentPosition;
        return !position || !chargePoints.has(position);
      })
      .map(([, location]) => location);
  }

  private async reconcileChargeTargets(
    chargePoints: ReadonlySet<string>,
  ): Promise<void> {
    for (const [vehicleName, target] of [...this.chargeTargets]) {
      const state = this.vehicleStore.get(vehicleName);
      if (state?.currentPosition && chargePoints.has(state.currentPosition)) {
        this.chargeTargets.delete(vehicleName);
        continue;
      }
      if (state?.transportOrder === target.order) continue;
      const orderState = await this.kernelApi.getTransportOrderState(
        target.order,
      );
      if (orderState === null || TERMINAL_ORDER_STATES.has(orderState)) {
        this.chargeTargets.delete(vehicleName);
      }
    }
  }

  forgetChargeTarget(vehicleName: string): void {
    this.chargeTargets.delete(vehicleName);
  }

  private hasInFlightCharge(
    vehicleName: string,
    chargePoints: ReadonlySet<string>,
  ): boolean {
    const target = this.chargeTargets.get(vehicleName);
    if (!target) return false;
    const position = this.vehicleStore.get(vehicleName)?.currentPosition;
    if (position && chargePoints.has(position)) {
      this.chargeTargets.delete(vehicleName);
      return false;
    }
    return true;
  }

  private async createChargeOrder(
    vehicleName: string,
    locationName: string,
    reason: string,
  ): Promise<void> {
    try {
      const { orderName } = await this.directTasks.create({
        kind: TaskKind.CHARGE,
        trigger: 'CHARGE_ENGINE',
        vehicleName,
        aimedAt: locationName,
        destinations: [
          { locationName, operation: this.kernelApi.chargeOperation },
        ],
      });
      if (!orderName) return;
      this.chargeTargets.set(vehicleName, {
        location: locationName,
        order: orderName,
      });
      this.logger.log(
        `Charging ${vehicleName} → ${locationName} (${orderName}) — ${reason}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to charge ${vehicleName}: ${(err as Error).message}`,
      );
    }
  }
}
