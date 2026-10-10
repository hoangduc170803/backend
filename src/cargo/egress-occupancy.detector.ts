import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Subscription } from 'rxjs';
import { Repository } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { CargoEntity } from './entities/cargo.entity';
import { EgressOccupancyEventEntity } from './entities/egress-occupancy-event.entity';
import {
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { DeliverySlotEngine } from './delivery-slot.engine';
import { allocatedPointNames } from './domain/lane-safety.policy';
import {
  describeEgressCell,
  egressCellsOf,
  type EgressCell,
} from './domain/egress-path';
import type { ZoneSlotLayout } from './domain/zone-slot-layout';

const ASSIGNED_VEHICLE_EXPRESSION = `task.metadata ->> 'assignedVehicleName'`;
const UNLOADED_AT_EXPRESSION = `task.metadata ->> 'unloadedAt'`;

interface ZoneEgress {
  readonly zone: ZoneEntity;
  readonly layout: ZoneSlotLayout;
  readonly cells: ReadonlyMap<string, EgressCell>;
}

interface Sighting {
  readonly vehicleName: string;
  readonly state: KernelVehicleState;
  readonly cell: EgressCell;
  readonly zoneEgress: ZoneEgress;
  readonly task: TransportTaskEntity;
  readonly cargo: CargoEntity;
}

interface OpenEvent {
  readonly eventId: string;
  readonly pointName: string;
}

@Injectable()
export class EgressOccupancyDetector implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EgressOccupancyDetector.name);
  private subscription: Subscription | null = null;
  private readonly lastPositionByVehicle = new Map<string, string | null>();
  private readonly openEventByVehicle = new Map<string, OpenEvent>();
  private readonly egressByZone = new Map<string, ZoneEgress>();
  private pending: Promise<void> = Promise.resolve();

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    @InjectRepository(EgressOccupancyEventEntity)
    private readonly eventRepo: Repository<EgressOccupancyEventEntity>,
    private readonly vehicleStore: VehicleStateStore,
    private readonly deliverySlotEngine: DeliverySlotEngine,
    private readonly kernelApi: KernelApiService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  onModuleInit(): void {
    this.subscription = this.vehicleStore.vehicleUpdates.subscribe((state) =>
      this.onVehicleUpdate(state),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = null;
    await this.settled();
  }

  settled(): Promise<void> {
    return this.pending;
  }

  onVehicleUpdate(state: KernelVehicleState): void {
    const position = positionOf(state);
    if (this.lastPositionByVehicle.get(state.name) === position) return;

    this.lastPositionByVehicle.set(state.name, position);
    this.pending = this.pending
      .then(() => this.onVehicleMoved(state, position))
      .catch((err: unknown) =>
        this.logger.error(
          `Egress occupancy update for ${state.name} failed: ${(err as Error).message}`,
        ),
      );
  }

  private async onVehicleMoved(
    state: KernelVehicleState,
    position: string | null,
  ): Promise<void> {
    const sighting = position ? await this.sightingAt(state, position) : null;
    const open = this.openEventByVehicle.get(state.name);
    if (open?.pointName === sighting?.cell.pointName) return;

    if (open) await this.closeEvent(state.name, open);
    if (sighting) await this.openEvent(sighting);
  }

  private async sightingAt(
    state: KernelVehicleState,
    position: string,
  ): Promise<Sighting | null> {
    const task = await this.taskStillCarryingCargo(state.name);
    if (!task?.cargoId) return null;

    const cargo = await this.cargoRepo.findOne({ where: { id: task.cargoId } });
    if (!cargo?.destinationZoneId) return null;

    const zoneEgress = await this.egressOf(cargo.destinationZoneId);
    const cell = zoneEgress?.cells.get(position);
    if (!zoneEgress || !cell) return null;

    return { vehicleName: state.name, state, cell, zoneEgress, task, cargo };
  }

  /** The vehicle reporting positions is one of the LOADED map — a same-named vehicle's stuck
   *  DELIVERING task on another map must not be matched to it. */
  private async taskStillCarryingCargo(
    vehicleName: string,
  ): Promise<TransportTaskEntity | null> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return null;
    return this.taskRepo
      .createQueryBuilder('task')
      .where('task.status = :status', { status: TaskStatus.DELIVERING })
      .andWhere('task.map_record_id = :mapRecordId', { mapRecordId })
      .andWhere('task.cargoId IS NOT NULL')
      .andWhere(`${ASSIGNED_VEHICLE_EXPRESSION} = :vehicleName`, {
        vehicleName,
      })
      .andWhere(`${UNLOADED_AT_EXPRESSION} IS NULL`)
      .orderBy('task.createdAt', 'DESC')
      .getOne();
  }

  private async egressOf(zoneId: string): Promise<ZoneEgress | null> {
    const zone = await this.zoneRepo.findOne({ where: { id: zoneId } });
    if (!zone) return null;

    const layout = await this.deliverySlotEngine.layoutFor(zone);
    if (!layout) return null;

    const known = this.egressByZone.get(zoneId);
    if (known?.layout === layout) return known;

    const plantModel = await this.kernelApi.getPlantModelView();
    if (!plantModel) return null;

    const fresh: ZoneEgress = {
      zone,
      layout,
      cells: egressCellsOf(layout, plantModel.paths),
    };
    this.egressByZone.set(zoneId, fresh);
    return fresh;
  }

  private async openEvent(sighting: Sighting): Promise<void> {
    const { vehicleName, state, cell, zoneEgress, task, cargo } = sighting;
    const saved = await this.eventRepo.save(
      this.eventRepo.create({
        vehicleName,
        pointName: cell.pointName,
        egressKind: cell.kind,
        laneIndexes: [...cell.laneIndexes],
        cellsOutOfLane: cell.cellsOutOfLane,
        zoneId: zoneEgress.zone.id,
        zoneName: zoneEgress.zone.name,
        taskId: task.id,
        requestCode: task.requestCode,
        cargoId: cargo.id,
        itemCode: cargo.itemCode,
        transportOrderName: state.transportOrder ?? null,
        snapshot: this.snapshotOf(sighting),
        observedAt: state.observedAt ? new Date(state.observedAt) : null,
      }),
    );

    this.openEventByVehicle.set(vehicleName, {
      eventId: saved.id,
      pointName: cell.pointName,
    });
    this.logger.log(
      `${vehicleName} still carries ${cargo.itemCode} (cargo ${cargo.id}, task ${task.requestCode}) and is on the egress path of zone "${zoneEgress.zone.name}": ${describeEgressCell(cell)} — egress_occupancy_events id ${saved.id}`,
    );
  }

  private async closeEvent(
    vehicleName: string,
    open: OpenEvent,
  ): Promise<void> {
    this.openEventByVehicle.delete(vehicleName);
    const dwellMs = await this.stampLeftAt(open.eventId);
    this.logger.log(
      `${vehicleName} moved off the egress cell ${open.pointName} after ${describeDwell(dwellMs)} — egress_occupancy_events id ${open.eventId}`,
    );
  }

  private async stampLeftAt(eventId: string): Promise<number | null> {
    const rows: { dwell_ms: string | null }[] = await this.eventRepo.query(
      `UPDATE "egress_occupancy_events"
          SET "left_at" = now(),
              "dwell_ms" = ROUND(EXTRACT(EPOCH FROM (now() - "entered_at")) * 1000)
        WHERE "id" = $1
        RETURNING "dwell_ms"`,
      [eventId],
    );
    const dwellMs = rows[0]?.dwell_ms;
    return dwellMs == null ? null : Number(dwellMs);
  }

  private snapshotOf(sighting: Sighting): Record<string, unknown> {
    const { state, cell, zoneEgress, task, cargo } = sighting;
    return {
      vehicle: state,
      egressCell: cell,
      zone: { id: zoneEgress.zone.id, name: zoneEgress.zone.name },
      task: {
        id: task.id,
        requestCode: task.requestCode,
        status: task.status,
        assignedAt: task.assignedAt,
        startedAt: task.startedAt,
        metadata: task.metadata,
      },
      cargo,
      lanes: zoneEgress.layout.lanes.map((lane, index) => ({
        index,
        axis: lane.axis,
        slots: lane.slots.map((slot) => slot.pointName),
        axisPoints: [...lane.axisPoints],
      })),
      egressCells: [...zoneEgress.cells.values()],
      fleetOnTheseLanes: this.fleetOnTheseLanes(zoneEgress),
    };
  }

  private fleetOnTheseLanes(
    zoneEgress: ZoneEgress,
  ): { vehicleName: string; pointName: string }[] {
    const laneCells = new Set(
      zoneEgress.layout.lanes.flatMap((lane) => [...lane.axisPoints]),
    );
    return this.vehicleStore
      .getAll()
      .reduce<{ vehicleName: string; pointName: string }[]>((found, state) => {
        const pointName = positionOf(state);
        if (
          pointName &&
          (laneCells.has(pointName) || zoneEgress.cells.has(pointName))
        ) {
          found.push({ vehicleName: state.name, pointName });
        }
        return found;
      }, []);
  }
}

function positionOf(state: KernelVehicleState): string | null {
  if (state.currentPosition) return state.currentPosition;
  return allocatedPointNames(state.allocatedResources ?? [])[0] ?? null;
}

function describeDwell(dwellMs: number | null): string {
  return dwellMs === null
    ? 'an unknown time'
    : `${(dwellMs / 1000).toFixed(1)}s`;
}
