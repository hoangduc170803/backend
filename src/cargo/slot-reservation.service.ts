import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import type { ZoneEntity } from '../zones/entities/zone.entity';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { DeliverySlotEngine } from './delivery-slot.engine';
import {
  vehicleAheadInLane,
  vehicleParkedInColumn,
} from './domain/column-occupancy';
import { ZoneOccupancy, type ZoneClaim } from './domain/zone-occupancy';
import { ZONE_EVENTS } from './domain/events';
import {
  queueDiagnosis,
  queueOfLane,
  whereToQueue,
} from './domain/dropoff-lane';
import {
  laneIndexOfTarget,
  type ZoneLane,
  type ZoneSlotLayout,
} from './domain/zone-slot-layout';

const OCCUPYING_STATUSES = [CargoStatus.ACTIVE, CargoStatus.DELIVERED];
const NO_SLOT_LOG_EVERY_MS = 30_000;

export interface DisplacedCargo {
  cargoId: string;
  lostSlot: string;
  replacementSlot: string | null;
}

export interface SlotCommitResult {
  slot: string;
  keptOwnReservation: boolean;
  displaced: DisplacedCargo | null;
}

export interface ClaimedCell {
  readonly previous: string | null;
}

export interface SlotCommitOptions {
  readonly blockedLocationNames: ReadonlySet<string>;
  readonly unstealableLocationNames: ReadonlySet<string>;
  readonly lane: ZoneLane;
  readonly requesterVehicleName: string | null;
}

@Injectable()
export class SlotReservationService {
  private readonly logger = new Logger(SlotReservationService.name);
  private readonly lastLoggedAt = new Map<string, number>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly deliverySlotEngine: DeliverySlotEngine,
    private readonly eventEmitter: EventEmitter2,
    private readonly vehicleStore: VehicleStateStore,
  ) {}

  private announceReleasedSlot(zoneId: string): void {
    this.eventEmitter.emit(ZONE_EVENTS.SLOT_RELEASED, { zoneId });
    this.announceChangedSlot(zoneId);
  }

  private announceChangedSlot(zoneId: string): void {
    this.eventEmitter.emit(ZONE_EVENTS.SLOT_CHANGED, { zoneId });
  }

  async reserve(
    cargoId: string,
    zone: ZoneEntity,
    requesterVehicleName: string | null = null,
  ): Promise<string | null> {
    const layout = await this.deliverySlotEngine.layoutFor(zone);
    if (!layout) return null;

    const reserved = await this.withZoneLock(zone, async (manager) => {
      const cargo = await manager.getRepository(CargoEntity).findOne({
        where: { id: cargoId },
      });
      if (!cargo) return null;
      if (cargo.destinationLocationName) return cargo.destinationLocationName;
      if (cargo.reservedLocationName) return cargo.reservedLocationName;

      const occupancy = ZoneOccupancy.of(
        await this.zoneCargos(manager, zone.id),
        layout,
      );
      const target = whereToQueue(layout, occupancy);
      if (!target) {
        this.logger.warn(
          [
            `Cargo ${cargoId}: zone "${zone.name}" offered nowhere to queue`,
            ...queueDiagnosis(layout, occupancy).map((lane) => `  — ${lane}`),
          ].join('\n'),
        );
        return null;
      }

      if (
        await this.columnHeldByParkedVehicle(
          cargoId,
          zone,
          target,
          requesterVehicleName,
        )
      ) {
        return null;
      }

      await this.writeReservation(manager, cargo, target);
      return target;
    });
    if (reserved) this.announceChangedSlot(zone.id);
    return reserved;
  }

  async queueableSlots(zone: ZoneEntity, limit: number): Promise<number> {
    const layout = await this.deliverySlotEngine.layoutFor(zone);
    if (!layout) return 0;

    const claims: ZoneClaim[] = await this.dataSource
      .getRepository(CargoEntity)
      .find({
        where: { destinationZoneId: zone.id, status: In(OCCUPYING_STATUSES) },
      });
    let queueable = 0;
    while (queueable < limit) {
      const target = whereToQueue(layout, ZoneOccupancy.of(claims, layout));
      if (!target) break;
      if (await this.vehicleParkedInTheColumnOf(zone, target, null)) break;
      claims.push({
        id: `probe-${queueable}`,
        status: CargoStatus.ACTIVE,
        destinationLocationName: null,
        reservedLocationName: target,
      });
      queueable++;
    }
    return queueable;
  }

  async commit(
    cargoId: string,
    zone: ZoneEntity,
    options: SlotCommitOptions,
  ): Promise<SlotCommitResult | null> {
    const layout = await this.deliverySlotEngine.layoutFor(zone);
    if (!layout) return null;

    const committed = await this.withZoneLock(zone, async (manager) => {
      const cargo = await manager.getRepository(CargoEntity).findOne({
        where: { id: cargoId },
      });
      if (!cargo) return null;
      if (cargo.destinationLocationName) {
        return {
          slot: cargo.destinationLocationName,
          keptOwnReservation: true,
          displaced: null,
        };
      }

      const ownReservation = cargo.reservedLocationName;
      const zoneCargos = await this.zoneCargos(manager, zone.id);
      const occupancy = ZoneOccupancy.of(zoneCargos, layout);
      const chosen = this.chooseSlot(layout, occupancy, options);
      if (!chosen) {
        if (this.dueToRepeat(`commit:${cargoId}`)) {
          this.logger.debug(
            `Cargo ${cargoId}: zone "${zone.name}" offered no slot to commit yet`,
          );
        }
        return null;
      }
      this.lastLoggedAt.delete(`commit:${cargoId}`);

      if (
        await this.columnHeldByVehicleAhead(
          cargoId,
          zone,
          chosen,
          options.lane,
          options.requesterVehicleName,
        )
      ) {
        return null;
      }

      const holder = occupancy.holderOf(chosen, cargo);

      await this.writeCommit(manager, cargo, chosen);

      if (!holder) {
        return {
          slot: chosen,
          keptOwnReservation: ownReservation === chosen,
          displaced: null,
        };
      }

      const replacement = await this.reassign(
        manager,
        layout,
        zone,
        ZoneOccupancy.of(zoneCargos, layout),
        holder,
        cargo,
        chosen,
      );
      return {
        slot: chosen,
        keptOwnReservation: false,
        displaced: {
          cargoId: holder.id,
          lostSlot: chosen,
          replacementSlot: replacement,
        },
      };
    });
    if (committed) this.announceChangedSlot(zone.id);
    return committed;
  }

  async release(cargoId: string, zoneId: string): Promise<void> {
    await this.dataSource
      .getRepository(CargoEntity)
      .update(cargoId, { reservedLocationName: null });
    this.announceReleasedSlot(zoneId);
  }

  async releaseCommit(cargoId: string, zone: ZoneEntity): Promise<void> {
    this.lastLoggedAt.delete(`commit:${cargoId}`);
    await this.withZoneLock(zone, async (manager) => {
      const cargo = await manager
        .getRepository(CargoEntity)
        .findOne({ where: { id: cargoId } });
      if (!cargo?.destinationLocationName) return;

      const nextSeq = cargo.slotDecisionSeq + 1;
      await manager.getRepository(CargoEntity).update(cargo.id, {
        destinationLocationName: null,
        slotDecisionSeq: nextSeq,
      });
      cargo.destinationLocationName = null;
      cargo.slotDecisionSeq = nextSeq;
    });
    this.announceReleasedSlot(zone.id);
  }

  private async columnHeldByParkedVehicle(
    cargoId: string,
    zone: ZoneEntity,
    target: string,
    requesterVehicleName: string | null,
  ): Promise<boolean> {
    const parked = await this.vehicleParkedInTheColumnOf(
      zone,
      target,
      requesterVehicleName,
    );
    if (!parked) {
      this.lastLoggedAt.delete(`column:${cargoId}`);
      return false;
    }

    if (this.dueToRepeat(`column:${cargoId}`)) {
      this.logger.log(
        `Cargo ${cargoId}: ${target} is free but ${parked.name} stands at ${parked.currentPosition} in the same column with no order — holding`,
      );
    }
    return true;
  }

  private async vehicleParkedInTheColumnOf(
    zone: ZoneEntity,
    target: string,
    requesterVehicleName: string | null,
  ): Promise<{ name: string; currentPosition: string | null } | null> {
    const columnPoints = await this.deliverySlotEngine.columnPointsFor(
      zone,
      target,
    );
    if (columnPoints.size === 0) return null;

    return vehicleParkedInColumn(
      this.vehicleStore.getAll(),
      columnPoints,
      requesterVehicleName,
    );
  }

  private async columnHeldByVehicleAhead(
    cargoId: string,
    zone: ZoneEntity,
    target: string,
    lane: ZoneLane,
    requesterVehicleName: string | null,
  ): Promise<boolean> {
    const columnPoints = await this.deliverySlotEngine.columnPointsFor(
      zone,
      target,
    );
    const laneAxis = {
      axisPoints: columnPoints.size > 0 ? [...columnPoints] : lane.axisPoints,
    };
    const requesterPosition = requesterVehicleName
      ? (this.vehicleStore.get(requesterVehicleName)?.currentPosition ?? null)
      : null;
    const blockingVehicle = vehicleAheadInLane(
      this.vehicleStore.getAll(),
      laneAxis,
      requesterVehicleName,
      requesterPosition,
    );
    if (!blockingVehicle) {
      this.lastLoggedAt.delete(`column:${cargoId}`);
      return false;
    }

    if (this.dueToRepeat(`column:${cargoId}`)) {
      this.logger.log(
        `Cargo ${cargoId}: ${target} is free but ${blockingVehicle.name} stands at ${blockingVehicle.currentPosition} deeper in the lane — holding`,
      );
    }
    return true;
  }

  private dueToRepeat(key: string): boolean {
    const now = Date.now();
    const last = this.lastLoggedAt.get(key);
    if (last !== undefined && now - last < NO_SLOT_LOG_EVERY_MS) return false;

    this.lastLoggedAt.set(key, now);
    return true;
  }

  private chooseSlot(
    layout: ZoneSlotLayout,
    occupancy: ZoneOccupancy,
    options: SlotCommitOptions,
  ): string | null {
    const laneIndex = layout.lanes.indexOf(options.lane);
    if (laneIndex === -1) return null;

    const claims = occupancy.columnClaims();
    const queue = queueOfLane(layout, laneIndex, {
      finished: claims.finished,
      committed: new Set([
        ...claims.committed,
        ...options.blockedLocationNames,
        ...options.unstealableLocationNames,
      ]),
      reserved: new Set<string>(),
    });
    return queue.next('commit')?.locationName ?? null;
  }

  private async reassign(
    manager: EntityManager,
    layout: ZoneSlotLayout,
    zone: ZoneEntity,
    afterCommit: ZoneOccupancy,
    holder: CargoEntity,
    committer: CargoEntity,
    committedSlot: string,
  ): Promise<string | null> {
    const lane = layout.lanes[laneIndexOfTarget(layout, committedSlot) ?? -1];
    const ranked = this.deliverySlotEngine.rank(
      layout,
      afterCommit.claimedTargets(),
    );
    const replacementSlot = lane
      ? firstSlotInLane(ranked, lane)
      : (ranked[0]?.locationName ?? null);
    if (!replacementSlot) {
      this.logger.error(
        `Cargo ${holder.id}: lost ${committedSlot} to cargo ${committer.id} and zone "${zone.name}" has nothing left`,
      );
      await this.writeReservation(manager, holder, null);
      return null;
    }

    await this.writeReservation(manager, holder, replacementSlot);
    return replacementSlot;
  }

  async claimCell(
    cargoId: string,
    target: string,
    zone: ZoneEntity,
  ): Promise<ClaimedCell | null> {
    const claimed = await this.withZoneLock(zone, async (manager) => {
      const repo = manager.getRepository(CargoEntity);
      const cargo = await repo.findOne({ where: { id: cargoId } });
      if (!cargo || cargo.destinationLocationName) return null;
      if (cargo.reservedLocationName === target) return { previous: target };

      const holder = await repo.findOne({
        where: {
          ...(cargo.mapRecordId
            ? { mapRecordId: cargo.mapRecordId }
            : { destinationZoneId: zone.id }),
          status: CargoStatus.ACTIVE,
          reservedLocationName: target,
        },
      });
      if (holder && holder.id !== cargoId) return null;

      const previous = cargo.reservedLocationName;
      await this.writeReservation(manager, cargo, target);
      return { previous };
    });
    if (claimed) this.announceChangedSlot(zone.id);
    return claimed;
  }

  async restoreClaim(
    cargoId: string,
    target: string | null,
    zone: ZoneEntity,
  ): Promise<void> {
    await this.withZoneLock(zone, async (manager) => {
      const cargo = await manager
        .getRepository(CargoEntity)
        .findOne({ where: { id: cargoId } });
      if (!cargo || cargo.destinationLocationName) return;
      await this.writeReservation(manager, cargo, target);
    });
    this.announceChangedSlot(zone.id);
  }

  private async writeReservation(
    manager: EntityManager,
    cargo: CargoEntity,
    slot: string | null,
  ): Promise<void> {
    const nextSeq = cargo.slotDecisionSeq + 1;
    await manager.getRepository(CargoEntity).update(cargo.id, {
      reservedLocationName: slot,
      slotDecisionSeq: nextSeq,
    });
    cargo.reservedLocationName = slot;
    cargo.slotDecisionSeq = nextSeq;
  }

  private async writeCommit(
    manager: EntityManager,
    cargo: CargoEntity,
    slot: string,
  ): Promise<void> {
    const nextSeq = cargo.slotDecisionSeq + 1;
    await manager.getRepository(CargoEntity).update(cargo.id, {
      destinationLocationName: slot,
      reservedLocationName: null,
      slotDecisionSeq: nextSeq,
    });
    cargo.destinationLocationName = slot;
    cargo.reservedLocationName = null;
    cargo.slotDecisionSeq = nextSeq;
  }

  private zoneCargos(
    manager: EntityManager,
    zoneId: string,
  ): Promise<CargoEntity[]> {
    return manager.getRepository(CargoEntity).find({
      where: { destinationZoneId: zoneId, status: In(OCCUPYING_STATUSES) },
    });
  }

  private async withZoneLock<T>(
    zone: ZoneEntity,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
        [zone.id],
      );
      return work(manager);
    });
  }
}

function firstSlotInLane(
  ranked: readonly { locationName: string }[],
  lane: ZoneLane,
): string | null {
  const laneSlots = new Set(lane.slots.map((slot) => slot.locationName));
  return (
    ranked.find((slot) => laneSlots.has(slot.locationName))?.locationName ??
    null
  );
}
