import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  TransportTaskEntity,
  TaskKind,
  TaskStatus,
} from './entities/transport-task.entity';
import { CargoEntity } from './entities/cargo.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { ZoneGeometryService, MemberAxes } from './zone-geometry.service';
import {
  findBlocker,
  hasLeftColumn,
  PickupCandidate,
} from './domain/pickup-dependency.policy';

/** Statuses where the cargo is still physically sitting at its source point. */
const AT_SOURCE: readonly TaskStatus[] = [
  TaskStatus.CREATED,
  TaskStatus.READY_TO_ASSIGN,
  TaskStatus.BLOCKED,
  TaskStatus.PICKING_UP,
];

const IN_LANE: readonly TaskStatus[] = [...AT_SOURCE, TaskStatus.DELIVERING];

export interface PickupDecision {
  task: TransportTaskEntity;
  blocked: boolean;
  reason: string | null;
}

function awaitsPickup(task: TransportTaskEntity): boolean {
  return AT_SOURCE.includes(task.status);
}

function blockedReason(blocker: PickupCandidate): string {
  if (blocker.atSource) {
    return `Blocked by cargo at ${blocker.locationName} (closer to the aisle in the same lane)`;
  }
  return `Blocked by ${blocker.vehicleName ?? 'a vehicle'} still driving out of the lane from ${blocker.locationName}`;
}

@Injectable()
export class PickupDependencyService {
  private readonly logger = new Logger(PickupDependencyService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly zoneGeometry: ZoneGeometryService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly activeMap: ActiveMapContext,
  ) {}

  async evaluate(): Promise<PickupDecision[]> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return [];
    const tasks = await this.taskRepo.find({
      // Only CARGO tasks have a pickup lifecycle; MANUAL/PARK/CHARGE tasks use
      // the direct state machine (CREATED → EXECUTING) and must never be released.
      where: {
        status: In(IN_LANE as TaskStatus[]),
        mapRecordId,
        kind: TaskKind.CARGO,
      },
    });
    return this.decide(tasks);
  }

  async blockedTaskIds(): Promise<Set<string>> {
    const decisions = await this.evaluate();
    return new Set(
      decisions.flatMap((decision) =>
        decision.blocked ? [decision.task.id] : [],
      ),
    );
  }

  async isBlocked(task: TransportTaskEntity): Promise<boolean> {
    const cargo = task.cargoId
      ? await this.cargoRepo.findOne({ where: { id: task.cargoId } })
      : null;
    if (!cargo?.sourceZoneId) return false;

    const peers = await this.taskRepo
      .createQueryBuilder('t')
      .innerJoin(CargoEntity, 'c', 'c.id = t.cargo_id')
      .where('c.source_zone_id = :zoneId', { zoneId: cargo.sourceZoneId })
      .andWhere('t.status IN (:...statuses)', { statuses: IN_LANE })
      .andWhere('t.kind = :kind', { kind: TaskKind.CARGO })
      .getMany();

    const decisions = await this.decide(peers);
    return decisions.find((d) => d.task.id === task.id)?.blocked ?? false;
  }

  private async decide(
    tasks: TransportTaskEntity[],
  ): Promise<PickupDecision[]> {
    if (tasks.length === 0) return [];

    const cargoIds = tasks.reduce<string[]>((ids, task) => {
      if (task.cargoId !== null) ids.push(task.cargoId);
      return ids;
    }, []);
    const cargos = cargoIds.length
      ? await this.cargoRepo.find({ where: { id: In(cargoIds) } })
      : [];
    const cargoById = new Map(cargos.map((c) => [c.id, c]));

    const byZone = new Map<
      string,
      Array<{ task: TransportTaskEntity; loc: string }>
    >();
    const decisions: PickupDecision[] = [];
    const zonesById = await this.zonesById(
      cargos.flatMap((cargo) =>
        cargo.sourceZoneId ? [cargo.sourceZoneId] : [],
      ),
    );

    for (const task of tasks) {
      const cargo = task.cargoId ? cargoById.get(task.cargoId) : undefined;
      const zoneId = cargo?.sourceZoneId ?? null;
      const loc = cargo?.sourcePickupLocationName ?? null;
      if (!zoneId || !loc) {
        if (awaitsPickup(task)) {
          decisions.push({ task, blocked: false, reason: null });
        }
        continue;
      }
      const list = byZone.get(zoneId) ?? [];
      list.push({ task, loc });
      byZone.set(zoneId, list);
    }

    for (const [zoneId, entries] of byZone) {
      const zone = zonesById.get(zoneId);
      const laneIndex = zone ? await this.zoneGeometry.laneIndexOf(zone) : null;

      if (!laneIndex) {
        this.logger.error(
          `Zone "${zone?.name ?? zoneId}": no geometry, holding ${entries.length} task(s) where` +
            ' they are. Releasing them would let a vehicle drive into a lane behind cargo that' +
            ' has not been collected yet.',
        );
        continue;
      }

      const candidates: PickupCandidate[] = [];
      const candByTask = new Map<string, PickupCandidate>();
      for (const e of entries) {
        const axes: MemberAxes | undefined = laneIndex.axesByLocation.get(
          e.loc,
        );
        if (!axes) continue;
        const cand = this.candidateOf(
          e.task,
          e.loc,
          axes,
          laneIndex.pointsByLane.get(axes.laneKey) ?? new Set<string>(),
        );
        candidates.push(cand);
        candByTask.set(e.task.id, cand);
      }

      for (const e of entries) {
        if (!awaitsPickup(e.task)) continue;
        const cand = candByTask.get(e.task.id);
        if (!cand) {
          decisions.push({ task: e.task, blocked: false, reason: null });
          continue;
        }
        const blocker = findBlocker(cand, candidates);
        decisions.push({
          task: e.task,
          blocked: blocker !== null,
          reason: blocker ? blockedReason(blocker) : null,
        });
      }
    }

    return decisions;
  }

  private candidateOf(
    task: TransportTaskEntity,
    locationName: string,
    axes: MemberAxes,
    lanePoints: ReadonlySet<string>,
  ): PickupCandidate {
    const atSource = awaitsPickup(task);
    const vehicleName = task.metadata?.assignedVehicleName ?? null;
    return {
      taskId: task.id,
      laneKey: axes.laneKey,
      depthKey: axes.depthKey,
      locationName,
      atSource,
      vehicleName,
      vehicleLeftColumn: atSource
        ? false
        : this.vehicleLeftColumn(task, vehicleName, lanePoints),
    };
  }

  private vehicleLeftColumn(
    task: TransportTaskEntity,
    vehicleName: string | null,
    lanePoints: ReadonlySet<string>,
  ): boolean {
    if (!vehicleName) {
      this.logger.warn(
        `Task ${task.id} is past its source point with no assigned vehicle — holding its lane`,
      );
      return false;
    }
    const state = this.vehicleStore.get(vehicleName);
    if (!state) {
      this.logger.warn(
        `No kernel state for ${vehicleName} — holding the lane of task ${task.id}`,
      );
      return false;
    }
    return hasLeftColumn(state.allocatedResources ?? [], lanePoints);
  }

  private async zonesById(
    zoneIds: readonly string[],
  ): Promise<Map<string, ZoneEntity>> {
    const unique = [...new Set(zoneIds)];
    if (unique.length === 0) return new Map();
    const zones = await this.zoneRepo.find({ where: { id: In(unique) } });
    return new Map(zones.map((zone) => [zone.id, zone]));
  }
}
