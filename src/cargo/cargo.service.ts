import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { MapRecordEntity } from '../maps/infrastructure/entities/map-record.entity';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { TaskStatusTransitionEntity } from './entities/task-status-transition.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import {
  TransportTaskService,
  type StatusChangeLog,
} from './transport-task.service';
import { TaskTerminationService } from './task-termination.service';
import { LaneSafetyService } from './lane-safety.service';
import { LoadHandlingGuard } from './load-handling.guard';
import { DeliverySlotEngine } from './delivery-slot.engine';
import { EnvironmentalEntitySyncService } from '../environmental-entities/environmental-entity-sync.service';
import type { DispatchMatcher } from './domain/dispatch.policy';
import {
  holdsDestinationCapacity,
  isStillAtSource,
  latestTaskByCargoId,
  latestTaskStatusByCargoId,
} from './task-queries';
import {
  ZoneEntity,
  ZoneStatus,
  ZoneType,
} from '../zones/entities/zone.entity';
import type {
  CargoAssignmentDecisionDto,
  CargoListResponse,
  CargoRegistryResponse,
  CargoRegistrySummary,
  CargoResponseDto,
  CargoVisualDto,
  CreateCargoDto,
  ListCargosQueryDto,
} from './cargo.dto';

export type SourceAvailability =
  | 'AVAILABLE'
  | 'POINT_NOT_FOUND'
  | 'NOT_PICKUP_POINT'
  | 'OCCUPIED_BY_CARGO'
  | 'LANE_COMMITTED';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

const ASSIGNMENT_TRIGGER = 'ASSIGNMENT_ENGINE';

const SEARCHABLE_COLUMNS = [
  'cargo.itemCode',
  'cargo.sourcePointName',
  'cargo.destinationLocationName',
];

const NEWEST_TASK_HAS_STATUS = `EXISTS (
  SELECT 1
  FROM transport_requests candidate
  WHERE candidate.cargo_id = cargo.id
    AND candidate.status = :taskStatus
    AND candidate.created_at = (
      SELECT MAX(any_task.created_at)
      FROM transport_requests any_task
      WHERE any_task.cargo_id = cargo.id
    )
)`;

const LATEST_TASK_STATUS = `(SELECT candidate.status::text FROM transport_requests candidate WHERE candidate.cargo_id = cargo.id ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1)`;
const LATEST_TASK_VEHICLE = `(SELECT candidate.metadata->>'assignedVehicleName' FROM transport_requests candidate WHERE candidate.cargo_id = cargo.id ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1)`;
const RUNNING_TASK_STATUSES = [TaskStatus.PICKING_UP, TaskStatus.DELIVERING];
const CARGO_WAS_DELIVERED = `cargo.delivered_at IS NOT NULL`;
const CARGO_ENDED_UNDELIVERED = `cargo.delivered_at IS NULL AND (cargo.deleted_at IS NOT NULL OR cargo.status IN (:...endedStatuses))`;
const CARGO_IS_ACTIVE = `cargo.delivered_at IS NULL AND cargo.deleted_at IS NULL AND cargo.status = :activeStatus`;
const REGISTRY_SUMMARY = {
  delivered: `COUNT(*) FILTER (WHERE ${CARGO_WAS_DELIVERED})`,
  failed: `COUNT(*) FILTER (WHERE ${CARGO_ENDED_UNDELIVERED})`,
  active: `COUNT(*) FILTER (WHERE ${CARGO_IS_ACTIVE})`,
  running: `COUNT(*) FILTER (WHERE ${CARGO_IS_ACTIVE} AND ${LATEST_TASK_STATUS} IN (:...runningTaskStatuses))`,
};
const REGISTRY_COLUMNS: Record<string, string> = {
  code: 'cargo.item_code',
  map: 'map.name',
  status: 'cargo.status::text',
  task: LATEST_TASK_STATUS,
  source: 'cargo.source_point_name',
  destination: 'cargo.destination_location_name',
  vehicle: LATEST_TASK_VEHICLE,
  created: 'cargo.created_at',
  updated: 'cargo.updated_at',
};

function readFiniteNumber(
  context: Record<string, unknown>,
  key: string,
): number | null {
  const value = context[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonEmptyString(
  context: Record<string, unknown>,
  key: string,
): string | null {
  const value = context[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readMatcher(context: Record<string, unknown>): DispatchMatcher | null {
  const matcher = context.matcher;
  return matcher === 'hungarian' || matcher === 'greedy' ? matcher : null;
}

function otherMatcher(matcher: DispatchMatcher): DispatchMatcher {
  return matcher === 'greedy' ? 'hungarian' : 'greedy';
}

function toAssignmentDecision(
  cargoId: string,
  taskId: string,
  transition: TaskStatusTransitionEntity,
): CargoAssignmentDecisionDto {
  const context = transition.context ?? {};
  const matcher = readMatcher(context);
  const alternativeVehicleName = readNonEmptyString(context, 'altVehicleName');

  return {
    cargoId,
    taskId,
    decidedAt: transition.occurredAt,
    vehicleName: transition.vehicleName,
    matcher,
    matchedRequestCount: readFiniteNumber(context, 'batchSize'),
    distanceToSource: readFiniteNumber(context, 'distanceToSource'),
    approachDistance: readFiniteNumber(context, 'approachDistance'),
    alternative:
      matcher && alternativeVehicleName
        ? {
            matcher: otherMatcher(matcher),
            vehicleName: alternativeVehicleName,
            distanceToSource: readFiniteNumber(context, 'altDistanceToSource'),
          }
        : null,
  };
}

export interface CargoRemovalOutcome {
  cargoId: string;
  reason: string | null;
}

const CARGO_NOT_FOUND = 'Cargo not found.';
const NOT_ON_LOADED_MAP = 'Không tìm thấy hàng trên bản đồ đang tải.';
const DELIVERED_CARGO_REMOVED = 'Hàng đã giao bị xoá';

export interface CargoListScope {
  /** `null` = every map, including legacy cargo without one. */
  mapIds: string[] | null;
  excludeCancelled?: boolean;
}

@Injectable()
export class CargoService {
  private readonly logger = new Logger(CargoService.name);

  constructor(
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(TaskStatusTransitionEntity)
    private readonly transitionRepo: Repository<TaskStatusTransitionEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly kernelApi: KernelApiService,
    private readonly transportTask: TransportTaskService,
    private readonly laneSafety: LaneSafetyService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly taskTermination: TaskTerminationService,
    private readonly deliverySlotEngine: DeliverySlotEngine,
    private readonly activeMap: ActiveMapContext,
    private readonly loadHandling: LoadHandlingGuard,
    private readonly entitySync: EnvironmentalEntitySyncService,
  ) {}

  async create(dto: CreateCargoDto, userId: string): Promise<CargoEntity> {
    const loadedMapId = await this.loadedMapId();
    const itemCode =
      dto.itemCode?.trim() || `ITEM-${Date.now().toString(36).toUpperCase()}`;

    const itemCodeConflict = await this.findItemCodeConflict(
      this.cargoRepo,
      itemCode,
      loadedMapId,
    );
    if (itemCodeConflict) {
      throw new ConflictException(
        `Mã hàng "${itemCode}" đã tồn tại trong bản đồ đang tải.`,
      );
    }

    const pickupLocationName = await this.kernelApi.findPickupLocationForPoint(
      dto.sourcePointName,
    );
    if (!pickupLocationName) {
      throw new BadRequestException(
        `Point "${dto.sourcePointName}" is invalid or is not linked to a PICKUP location.`,
      );
    }

    const occupiedSource = await this.findCargoStillAtSource(
      this.cargoRepo,
      this.taskRepo,
      dto.sourcePointName,
      loadedMapId,
    );
    if (occupiedSource) {
      throw new BadRequestException(
        `Point "${dto.sourcePointName}" already has cargo waiting for transport (${occupiedSource.itemCode}).`,
      );
    }

    const zone = await this.zoneRepo.findOne({
      where: {
        id: dto.destinationZoneId,
        type: ZoneType.DROPOFF,
        status: ZoneStatus.ACTIVE,
        mapRecordId: loadedMapId,
      },
      relations: { members: true },
    });
    if (!zone) {
      throw new BadRequestException(
        'Khu trả hàng không tồn tại, không hoạt động, hoặc không thuộc bản đồ đang tải.',
      );
    }

    const sourceZoneId = await this.resolvePickupZoneId(
      pickupLocationName,
      loadedMapId,
    );

    const capacity = await this.reachableCapacityOf(zone);
    await this.assertZoneHasRoom(this.cargoRepo, this.taskRepo, zone, capacity);

    if (sourceZoneId) {
      await this.laneSafety.clearLaneForNewCargo(
        sourceZoneId,
        pickupLocationName,
      );
    }

    const { saved, task } = await this.dataSource.transaction(
      async (manager) => {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          [zone.id],
        );
        // Same lock pattern as the destination zone above, keyed on the source point instead —
        // closes the TOCTOU race where two concurrent creates both read "source free" before
        // either commits. Always acquired zone-then-source in this one call site, so there's no
        // lock-order inversion with any other transaction to deadlock against.
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          [`cargo-source:${loadedMapId}:${dto.sourcePointName}`],
        );
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          [`cargo-item-code:${loadedMapId}:${itemCode}`],
        );
        const cargoRepo = manager.getRepository(CargoEntity);
        const taskRepo = manager.getRepository(TransportTaskEntity);
        await this.assertZoneHasRoom(cargoRepo, taskRepo, zone, capacity);

        const duplicateItemCode = await this.findItemCodeConflict(
          cargoRepo,
          itemCode,
          loadedMapId,
        );
        if (duplicateItemCode) {
          throw new ConflictException(
            `Mã hàng "${itemCode}" đã tồn tại trong bản đồ đang tải.`,
          );
        }

        const stillOccupied = await this.findCargoStillAtSource(
          cargoRepo,
          taskRepo,
          dto.sourcePointName,
          loadedMapId,
        );
        if (stillOccupied) {
          throw new BadRequestException(
            `Point "${dto.sourcePointName}" already has cargo waiting for transport (${stillOccupied.itemCode}).`,
          );
        }

        const saved = await cargoRepo.save(
          cargoRepo.create({
            itemCode,
            sourcePointName: dto.sourcePointName,
            sourcePickupLocationName: pickupLocationName,
            destinationZoneId: zone.id,
            destinationLocationName: null,
            sourceZoneId,
            mapRecordId: loadedMapId,
            status: CargoStatus.ACTIVE,
            createdBy: userId,
          }),
        );

        const requestCode = `TR-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`;
        const task = await manager.getRepository(TransportTaskEntity).save(
          manager.getRepository(TransportTaskEntity).create({
            requestCode,
            cargoId: saved.id,
            mapRecordId: loadedMapId,
            status: TaskStatus.CREATED,
            metadata: {},
          }),
        );

        return { saved, task };
      },
    );

    // Emit after commit so dispatch listeners see the persisted task/cargo.
    this.transportTask.publishCreated(task);

    return saved;
  }

  /**
   * `scope.mapIds` narrows to those maps (`null` = every row, legacy mapless ones included) and
   * wins over `query.activeMapOnly`; `excludeCancelled` keeps `total` equal to what a list that
   * hides cancelled cargo can actually show.
   */
  async list(
    query: ListCargosQueryDto = {},
    scope?: CargoListScope,
  ): Promise<CargoListResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const mapIds =
      scope !== undefined
        ? scope.mapIds
        : query.activeMapOnly
          ? [await this.loadedMapId()]
          : null;
    if (mapIds !== null && mapIds.length === 0) {
      return { cargos: [], total: 0, page, limit, truncated: false };
    }

    const [cargos, total] = await this.buildListQuery(
      query,
      mapIds,
      scope?.excludeCancelled ?? false,
    )
      .orderBy('cargo.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      cargos: await this.enrichCargos(cargos),
      total,
      page,
      limit,
      truncated: page * limit < total,
    };
  }

  async registry(query: ListCargosQueryDto): Promise<CargoRegistryResponse> {
    if (
      query.status &&
      !Object.values(CargoStatus).includes(query.status as CargoStatus)
    ) {
      throw new BadRequestException('Invalid cargo status.');
    }
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      throw new BadRequestException(
        'from must be earlier than or equal to to.',
      );
    }
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const statuses = query.statuses?.split(',').filter(Boolean) ?? [];
    if (
      statuses.some(
        (value) => !Object.values(CargoStatus).includes(value as CargoStatus),
      )
    ) {
      throw new BadRequestException('Invalid cargo statuses.');
    }
    const mapRecordIds = query.mapRecordIds?.split(',').filter(Boolean) ?? [];
    if (
      mapRecordIds.some(
        (value) =>
          !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
            value,
          ),
      )
    ) {
      throw new BadRequestException('Invalid map identifiers.');
    }
    let columnFilters: Record<string, unknown> = {};
    if (query.columnFilters) {
      try {
        const parsed: unknown = JSON.parse(query.columnFilters);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error();
        columnFilters = parsed as Record<string, unknown>;
      } catch {
        throw new BadRequestException('Invalid column filters.');
      }
    }
    const filtered = this.buildListQuery(query, null, false)
      .withDeleted()
      .leftJoin(MapRecordEntity, 'map', 'map.id = cargo.map_record_id');
    if (statuses.length)
      filtered.andWhere('cargo.status IN (:...statuses)', { statuses });
    if (mapRecordIds.length)
      filtered.andWhere('cargo.map_record_id IN (:...mapRecordIds)', {
        mapRecordIds,
      });
    for (const [key, value] of Object.entries(columnFilters)) {
      const expression = REGISTRY_COLUMNS[key];
      if (!expression || typeof value !== 'string' || value.length > 255) {
        throw new BadRequestException('Invalid column filter.');
      }
      if (!value.trim()) continue;
      if (key === 'created' || key === 'updated') {
        const instant = new Date(value);
        if (Number.isNaN(instant.getTime()))
          throw new BadRequestException('Invalid date filter.');
        filtered.andWhere(
          `${expression} >= :${key}From AND ${expression} < :${key}To`,
          {
            [`${key}From`]: instant.toISOString(),
            [`${key}To`]: new Date(instant.getTime() + 60_000).toISOString(),
          },
        );
      } else {
        filtered.andWhere(`${expression} ILIKE :filter_${key}`, {
          [`filter_${key}`]: `%${value.trim()}%`,
        });
      }
    }
    const sortExpression = query.sortBy
      ? REGISTRY_COLUMNS[query.sortBy]
      : 'cargo.created_at';
    const direction = query.sortDir === 'asc' ? 'ASC' : 'DESC';
    const [cargos, total, summary] = await Promise.all([
      filtered
        .clone()
        .addSelect('map.name', 'map_name')
        .orderBy(sortExpression, direction, 'NULLS LAST')
        .addOrderBy('cargo.id', 'DESC')
        .offset((page - 1) * limit)
        .limit(limit)
        .getMany(),
      filtered.clone().getCount(),
      filtered
        .clone()
        .select(REGISTRY_SUMMARY.active, 'active')
        .addSelect(REGISTRY_SUMMARY.running, 'running')
        .addSelect(REGISTRY_SUMMARY.delivered, 'delivered')
        .addSelect(REGISTRY_SUMMARY.failed, 'failed')
        .setParameters({
          activeStatus: CargoStatus.ACTIVE,
          endedStatuses: [CargoStatus.FAILED, CargoStatus.CANCELLED],
          runningTaskStatuses: RUNNING_TASK_STATUSES,
        })
        .getRawOne<Record<keyof CargoRegistrySummary, string>>(),
    ]);
    const tasks = cargos.length
      ? await this.taskRepo.find({
          where: { cargoId: In(cargos.map((cargo) => cargo.id)) },
          order: { createdAt: 'DESC' },
        })
      : [];
    const latestTaskByCargo = new Map<string, TransportTaskEntity>();
    for (const task of tasks) {
      if (task.cargoId && !latestTaskByCargo.has(task.cargoId)) {
        latestTaskByCargo.set(task.cargoId, task);
      }
    }
    return {
      cargos: cargos.map((cargo) => {
        const task = latestTaskByCargo.get(cargo.id);
        return {
          id: cargo.id,
          itemCode: cargo.itemCode,
          status: cargo.status,
          taskStatus: task?.status ?? null,
          mapRecordId: cargo.mapRecordId,
          sourcePointName: cargo.sourcePointName,
          destinationLocationName: cargo.destinationLocationName,
          assignedVehicleName: task?.metadata.assignedVehicleName ?? null,
          createdAt: cargo.createdAt,
          updatedAt: cargo.updatedAt,
          deliveredAt: cargo.deliveredAt,
          deletedAt: cargo.deletedAt,
        };
      }),
      total,
      page,
      limit,
      truncated: page * limit < total,
      summary: {
        delivered: Number(summary?.delivered ?? 0),
        failed: Number(summary?.failed ?? 0),
        active: Number(summary?.active ?? 0),
        running: Number(summary?.running ?? 0),
      },
    };
  }

  async getAssignmentDecision(
    cargoId: string,
  ): Promise<CargoAssignmentDecisionDto> {
    const cargo = await this.cargoRepo.findOne({ where: { id: cargoId } });
    if (!cargo) throw new NotFoundException('Cargo not found.');

    const task = await this.taskRepo.findOne({
      where: { cargoId },
      order: { createdAt: 'DESC' },
    });
    if (!task) {
      throw new NotFoundException('Cargo has no transport request yet.');
    }

    const transition = await this.transitionRepo.findOne({
      where: {
        taskId: task.id,
        trigger: ASSIGNMENT_TRIGGER,
        toStatus: TaskStatus.PICKING_UP,
      },
      order: { occurredAt: 'DESC', id: 'DESC' },
    });
    if (!transition) {
      throw new NotFoundException(
        'This request has not been assigned to a vehicle yet.',
      );
    }

    return toAssignmentDecision(cargo.id, task.id, transition);
  }

  private buildListQuery(
    query: ListCargosQueryDto,
    mapIds: string[] | null,
    excludeCancelled: boolean,
  ): SelectQueryBuilder<CargoEntity> {
    const builder = this.cargoRepo.createQueryBuilder('cargo');

    if (mapIds !== null) {
      builder.andWhere('cargo.map_record_id IN (:...mapIds)', { mapIds });
    }
    if (query.mapRecordId) {
      builder.andWhere('cargo.map_record_id = :mapRecordId', {
        mapRecordId: query.mapRecordId,
      });
    }
    if (query.from) {
      builder.andWhere('cargo.created_at >= :from', { from: query.from });
    }
    if (query.to) {
      builder.andWhere('cargo.created_at <= :to', { to: query.to });
    }
    if (excludeCancelled) {
      builder.andWhere('cargo.status != :cancelled', {
        cancelled: CargoStatus.CANCELLED,
      });
    }

    if (query.status) {
      builder.andWhere('cargo.status = :status', {
        status: query.status as CargoStatus,
      });
    }

    const search = query.search?.trim();
    if (search) {
      const matches = SEARCHABLE_COLUMNS.map(
        (column) => `${column} ILIKE :search`,
      ).join(' OR ');
      builder.andWhere(`(${matches})`, { search: `%${search}%` });
    }

    if (query.taskStatus) {
      builder.andWhere(NEWEST_TASK_HAS_STATUS, {
        taskStatus: query.taskStatus,
      });
    }

    return builder;
  }

  async findOne(id: string): Promise<CargoResponseDto> {
    const cargo = await this.cargoRepo.findOne({ where: { id } });
    if (!cargo) {
      throw new NotFoundException('Cargo not found.');
    }

    const [mapped] = await this.enrichCargos([cargo]);
    return mapped;
  }

  async remove(
    id: string,
    loadedMapId?: string | null,
  ): Promise<{ message: string }> {
    const cargo = await this.cargoRepo.findOne({ where: { id } });
    if (!cargo) throw new NotFoundException(CARGO_NOT_FOUND);

    const task = await this.latestTaskOf(id);
    await this.stopTaskForRemoval(cargo, task, loadedMapId);
    await this.markRemoved([id], task ? [task] : []);
    return { message: 'Cargo deleted.' };
  }

  async removeManyOnMap(
    ids: readonly string[],
    loadedMapId: string | null,
  ): Promise<CargoRemovalOutcome[]> {
    const uniqueIds = [...new Set(ids)];
    const cargos = uniqueIds.length
      ? await this.cargoRepo.find({ where: { id: In(uniqueIds) } })
      : [];
    const cargoById = new Map(cargos.map((cargo) => [cargo.id, cargo]));
    const latestTasks = await latestTaskByCargoId(
      this.taskRepo,
      cargos.map((cargo) => cargo.id),
    );

    const outcomes: CargoRemovalOutcome[] = [];
    const removedIds: string[] = [];
    const stoppedTasks: TransportTaskEntity[] = [];
    for (const cargoId of uniqueIds) {
      const cargo = cargoById.get(cargoId);
      if (!cargo || cargo.mapRecordId !== loadedMapId) {
        outcomes.push({
          cargoId,
          reason: cargo ? NOT_ON_LOADED_MAP : CARGO_NOT_FOUND,
        });
        continue;
      }
      const task = latestTasks.get(cargoId) ?? null;
      try {
        await this.stopTaskForRemoval(cargo, task, loadedMapId);
        removedIds.push(cargoId);
        if (task) stoppedTasks.push(task);
        outcomes.push({ cargoId, reason: null });
      } catch (err) {
        outcomes.push({ cargoId, reason: (err as Error).message });
      }
    }

    await this.markRemoved(removedIds, stoppedTasks);
    return outcomes;
  }

  private async stopTaskForRemoval(
    cargo: CargoEntity,
    task: TransportTaskEntity | null,
    loadedMapId: string | null | undefined,
  ): Promise<void> {
    if (!task) return;
    await this.loadHandling.assertVehicleIsNotHandlingTheLoad(task, cargo);
    task.cancelledAt = new Date();
    await this.taskTermination.terminate(
      task,
      TaskStatus.CANCELLED,
      { trigger: 'API', reason: 'cargo deleted' },
      { onLoadedMap: await this.isOnLoadedMap(task, loadedMapId) },
    );
  }

  private async markRemoved(
    cargoIds: readonly string[],
    stoppedTasks: readonly TransportTaskEntity[],
  ): Promise<void> {
    if (cargoIds.length === 0) return;
    await this.entitySync.markRetiredMany(cargoIds, DELIVERED_CARGO_REMOVED);
    await this.cargoRepo.update(
      { id: In([...cargoIds]) },
      { status: CargoStatus.CANCELLED, deletedAt: new Date() },
    );
    for (const task of stoppedTasks) this.transportTask.publishUpdated(task);
  }

  async failCargo(
    cargoId: string,
    reason: string,
    log: StatusChangeLog,
  ): Promise<void> {
    const task = await this.latestTaskOf(cargoId);
    if (task) {
      task.cancelledAt = new Date();
      task.metadata = { ...task.metadata, cancelReason: reason };
      await this.taskTermination.terminate(
        task,
        TaskStatus.CANCELLED,
        { ...log, reason },
        { onLoadedMap: await this.isOnLoadedMap(task) },
      );
      this.transportTask.publishUpdated(task);
    }
    await this.cargoRepo.update(cargoId, { status: CargoStatus.FAILED });
  }

  private latestTaskOf(cargoId: string): Promise<TransportTaskEntity | null> {
    return this.taskRepo.findOne({
      where: { cargoId },
      order: { createdAt: 'DESC' },
    });
  }

  private async isOnLoadedMap(
    task: TransportTaskEntity,
    knownLoadedMapId?: string | null,
  ): Promise<boolean> {
    const loadedMapId =
      knownLoadedMapId === undefined
        ? await this.activeMap.id()
        : knownLoadedMapId;
    return task.mapRecordId === loadedMapId;
  }

  async getTaskByCargo(cargoId: string): Promise<TransportTaskEntity | null> {
    return this.taskRepo.findOne({ where: { cargoId } });
  }

  async inspectSource(sourcePointName: string): Promise<SourceAvailability> {
    const loadedMapId = await this.loadedMapId();

    const pickupLocationName =
      await this.kernelApi.findPickupLocationForPoint(sourcePointName);
    if (!pickupLocationName) {
      const pointExists = await this.kernelApi.hasPoint(sourcePointName);
      return pointExists ? 'NOT_PICKUP_POINT' : 'POINT_NOT_FOUND';
    }

    const occupant = await this.findCargoStillAtSource(
      this.cargoRepo,
      this.taskRepo,
      sourcePointName,
      loadedMapId,
    );
    if (occupant) return 'OCCUPIED_BY_CARGO';

    const sourceZoneId = await this.resolvePickupZoneId(
      pickupLocationName,
      loadedMapId,
    );
    const laneBlocker = sourceZoneId
      ? await this.laneSafety.findCommittedPickupInLane(
          sourceZoneId,
          pickupLocationName,
        )
      : null;
    return laneBlocker ? 'LANE_COMMITTED' : 'AVAILABLE';
  }

  async hasRoomIn(zone: ZoneEntity): Promise<boolean> {
    const capacity = await this.reachableCapacityOf(zone);
    const occupied = await this.countOccupiedSlots(
      this.cargoRepo,
      this.taskRepo,
      zone,
    );
    return occupied < capacity;
  }

  private async reachableCapacityOf(zone: ZoneEntity): Promise<number> {
    const reachable = await this.deliverySlotEngine.usableCapacityOf(zone);
    return reachable || zone.members.length;
  }

  private async assertZoneHasRoom(
    cargoRepo: Repository<CargoEntity>,
    taskRepo: Repository<TransportTaskEntity>,
    zone: ZoneEntity,
    capacity: number,
  ): Promise<void> {
    const occupied = await this.countOccupiedSlots(cargoRepo, taskRepo, zone);
    if (occupied >= capacity) {
      throw new BadRequestException(
        'Khu trả hàng đã đầy, không còn vị trí trống.',
      );
    }
  }

  private async countOccupiedSlots(
    cargoRepo: Repository<CargoEntity>,
    taskRepo: Repository<TransportTaskEntity>,
    zone: ZoneEntity,
  ): Promise<number> {
    const candidates = await cargoRepo.find({
      where: {
        destinationZoneId: zone.id,
        status: In([CargoStatus.ACTIVE, CargoStatus.DELIVERED]),
      },
    });
    const activeCargoIds = candidates
      .filter((cargo) => cargo.status === CargoStatus.ACTIVE)
      .map((cargo) => cargo.id);
    const statusByCargoId = await latestTaskStatusByCargoId(
      taskRepo,
      activeCargoIds,
    );
    return candidates.filter(
      (cargo) =>
        cargo.status === CargoStatus.DELIVERED ||
        holdsDestinationCapacity(statusByCargoId.get(cargo.id)),
    ).length;
  }

  private async findCargoStillAtSource(
    cargoRepo: Repository<CargoEntity>,
    taskRepo: Repository<TransportTaskEntity>,
    sourcePointName: string,
    mapRecordId: string,
  ): Promise<CargoEntity | null> {
    const candidates = await cargoRepo.find({
      where: {
        sourcePointName,
        mapRecordId,
        status: CargoStatus.ACTIVE,
      },
    });
    if (candidates.length === 0) return null;

    const statusByCargoId = await latestTaskStatusByCargoId(
      taskRepo,
      candidates.map((cargo) => cargo.id),
    );
    return (
      candidates.find((cargo) =>
        isStillAtSource(statusByCargoId.get(cargo.id)),
      ) ?? null
    );
  }

  private findItemCodeConflict(
    cargoRepo: Repository<CargoEntity>,
    itemCode: string,
    mapRecordId: string,
  ): Promise<CargoEntity | null> {
    return cargoRepo.findOne({ where: { itemCode, mapRecordId } });
  }

  private async loadedMapId(): Promise<string> {
    const id = await this.activeMap.id();
    if (!id) {
      throw new ServiceUnavailableException(
        'Không thể đọc bản đồ đang tải trên hệ thống điều khiển.',
      );
    }
    return id;
  }

  private async resolvePickupZoneId(
    pickupLocationName: string,
    loadedMapId: string,
  ): Promise<string | null> {
    const zone = await this.zoneRepo
      .createQueryBuilder('z')
      .innerJoin('z.members', 'm', 'm.locationName = :loc', {
        loc: pickupLocationName,
      })
      .where('z.type = :type', { type: ZoneType.PICKUP })
      .andWhere('z.status = :status', { status: ZoneStatus.ACTIVE })
      .andWhere('z.mapRecordId = :map', { map: loadedMapId })
      .getOne();
    return zone?.id ?? null;
  }

  private async enrichCargos(
    cargos: CargoEntity[],
  ): Promise<CargoResponseDto[]> {
    if (cargos.length === 0) return [];

    const destinationPointEntries = await Promise.all(
      cargos.map(
        async (cargo) =>
          [
            cargo.id,
            cargo.destinationLocationName
              ? await this.kernelApi.findPointForLocation(
                  cargo.destinationLocationName,
                )
              : null,
          ] as const,
      ),
    );
    const destinationPointByCargoId = new Map(destinationPointEntries);

    const tasks = await this.taskRepo.find({
      where: { cargoId: In(cargos.map((cargo) => cargo.id)) },
      order: { createdAt: 'DESC' },
    });

    const entitySyncByCargoId = await this.entitySync.viewsByCargoIds(
      cargos.map((cargo) => cargo.id),
    );

    const taskByCargoId = new Map<string, TransportTaskEntity>();
    for (const task of tasks) {
      if (task.cargoId && !taskByCargoId.has(task.cargoId)) {
        taskByCargoId.set(task.cargoId, task);
      }
    }

    return cargos.map((cargo) => {
      const task = taskByCargoId.get(cargo.id) ?? null;
      return {
        id: cargo.id,
        itemCode: cargo.itemCode,
        sourcePointName: cargo.sourcePointName,
        sourcePickupLocationName: cargo.sourcePickupLocationName,
        sourceZoneId: cargo.sourceZoneId,
        destinationZoneId: cargo.destinationZoneId,
        destinationLocationName: cargo.destinationLocationName,
        reservedLocationName: cargo.reservedLocationName,
        slotDecisionSeq: cargo.slotDecisionSeq,
        mapRecordId: cargo.mapRecordId,
        status: cargo.status,
        createdBy: cargo.createdBy,
        createdAt: cargo.createdAt,
        updatedAt: cargo.updatedAt,
        deletedAt: cargo.deletedAt,
        taskStatus: task?.status ?? null,
        assignedVehicleName: task?.metadata.assignedVehicleName ?? null,
        blockedReason:
          cargo.status === CargoStatus.FAILED
            ? (task?.metadata.cancelReason ?? null)
            : (task?.metadata.blockedReason ?? null),
        visual: this.resolveVisual(
          cargo,
          task,
          destinationPointByCargoId.get(cargo.id) ?? null,
        ),
        entitySync: entitySyncByCargoId.get(cargo.id) ?? null,
      };
    });
  }

  private resolveVisual(
    cargo: CargoEntity,
    task: TransportTaskEntity | null,
    destinationPointName: string | null,
  ): CargoVisualDto {
    const unloaded = !!task?.metadata?.unloadedAt;
    const lostOnVehicle = cargo.status === CargoStatus.FAILED && !unloaded;

    if (
      (task?.status === TaskStatus.DELIVERING || lostOnVehicle) &&
      !unloaded
    ) {
      return {
        state: 'ON_AGV',
        pointName: null,
        vehicleName: task?.metadata.assignedVehicleName ?? null,
      };
    }

    if (
      unloaded ||
      task?.status === TaskStatus.DELIVERY_COMPLETED ||
      cargo.status === CargoStatus.DELIVERED
    ) {
      return {
        state: 'AT_DESTINATION',
        pointName: destinationPointName ?? cargo.destinationLocationName,
        vehicleName: null,
      };
    }

    return {
      state: 'AT_SOURCE',
      pointName: cargo.sourcePointName,
      vehicleName: null,
    };
  }
}
