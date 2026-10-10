import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  In,
  IsNull,
  LessThanOrEqual,
  Not,
  Repository,
  type FindOptionsWhere,
  type SelectQueryBuilder,
  type WhereExpressionBuilder,
} from 'typeorm';
import { CargoEntity, CargoStatus } from '../cargo/entities/cargo.entity';
import { TransportTaskEntity } from '../cargo/entities/transport-task.entity';
import { latestTaskByCargoId } from '../cargo/task-queries';
import {
  CargoEnvironmentalEntity,
  EntityDesiredState,
  EntitySyncErrorKind,
  EntitySyncStatus,
} from './entities/cargo-environmental-entity.entity';
import {
  CargoEnvironmentalEntityLog,
  type EntitySyncLogEvent,
} from './entities/cargo-environmental-entity-log.entity';

export type EntityRowPatch = Partial<
  Pick<
    CargoEnvironmentalEntity,
    | 'entityName'
    | 'generation'
    | 'desiredState'
    | 'syncStatus'
    | 'errorKind'
    | 'attemptCount'
    | 'lastAttemptAt'
    | 'nextRetryAt'
    | 'ackedAt'
    | 'lastError'
    | 'sentEnvelope'
    | 'sentPose'
    | 'lastResponse'
  >
>;

export type NewEntityRow = Pick<
  CargoEnvironmentalEntity,
  | 'cargoId'
  | 'taskId'
  | 'mapRecordId'
  | 'itemCode'
  | 'destinationLocationName'
  | 'entityName'
  | 'generation'
  | 'desiredState'
  | 'syncStatus'
>;

export interface EntityLogEntry {
  cargoId: string | null;
  entityName: string | null;
  event: EntitySyncLogEvent;
  detail: string | null;
  payload: unknown;
}

/** One obstacle row with the cargo it stands for — the admin obstacle table's row. */
export interface EntityAdminRow {
  entity: CargoEnvironmentalEntity;
  cargo: CargoEntity | null;
}

export const ENTITY_ADMIN_FILTERS = ['present', 'retired', 'problem'] as const;
export type EntityAdminFilter = (typeof ENTITY_ADMIN_FILTERS)[number];

/**
 * What openTCS holds for the loaded map, as far as "does WES agree with it" goes: the names of
 * its active (not retired) entities. `kernelActiveNames: null` = the kernel could not be read,
 * so no row can be called a mismatch.
 */
export interface KernelAgreement {
  loadedMapId: string | null;
  kernelActiveNames: readonly string[] | null;
}

export interface EntityAdminPageQuery extends KernelAgreement {
  /** `null` = every row, including rows without a map. */
  mapIds: string[] | null;
  /** Any of these (OR); empty = no filter. */
  filters: readonly EntityAdminFilter[];
  search: string;
  offset: number;
  limit: number;
}

export interface EntityMapSummary {
  present: number;
  synced: number;
  problem: number;
}

export const OPEN_SYNC_STATUSES = [
  EntitySyncStatus.PENDING,
  EntitySyncStatus.SENDING,
  EntitySyncStatus.RETRYING,
];

export abstract class EntitySyncStore {
  abstract findByCargoId(
    cargoId: string,
  ): Promise<CargoEnvironmentalEntity | null>;
  abstract insert(row: NewEntityRow): Promise<CargoEnvironmentalEntity>;
  abstract update(id: string, patch: EntityRowPatch): Promise<void>;
  abstract updateIfDesired(
    id: string,
    desiredState: EntityDesiredState,
    patch: EntityRowPatch,
  ): Promise<boolean>;
  abstract updateMany(
    updates: { id: string; patch: EntityRowPatch }[],
  ): Promise<void>;
  abstract updateByIds(
    ids: readonly string[],
    patch: EntityRowPatch,
  ): Promise<void>;
  abstract findDue(
    now: Date,
    limit: number,
  ): Promise<CargoEnvironmentalEntity[]>;
  abstract findAll(): Promise<CargoEnvironmentalEntity[]>;
  abstract findByDesiredState(
    desiredState: EntityDesiredState,
  ): Promise<CargoEnvironmentalEntity[]>;
  abstract findByCargoIds(
    cargoIds: readonly string[],
  ): Promise<CargoEnvironmentalEntity[]>;
  abstract findOnMap(
    mapRecordId: string | null,
  ): Promise<CargoEnvironmentalEntity[]>;
  abstract appendLog(entry: EntityLogEntry): Promise<void>;
  abstract appendLogs(entries: readonly EntityLogEntry[]): Promise<void>;
  abstract findDeliveredCargoWithoutRow(limit: number): Promise<CargoEntity[]>;
  abstract findCargosIncludingDeleted(
    cargoIds: readonly string[],
  ): Promise<CargoEntity[]>;
  abstract findLatestTaskId(cargoId: string): Promise<string | null>;
  abstract findLatestTaskIds(
    cargoIds: readonly string[],
  ): Promise<Map<string, string>>;
  /** `mapIds: null` = every row, including rows without a map. */
  abstract findForAdmin(mapIds: string[] | null): Promise<EntityAdminRow[]>;
  /** One page of the admin table, newest first, with the total the filters match. */
  abstract findAdminPage(
    query: EntityAdminPageQuery,
  ): Promise<{ rows: EntityAdminRow[]; total: number }>;
  /** Counters of one map's obstacles, without loading its rows. */
  abstract summarizeMap(
    mapRecordId: string,
    kernelActiveNames: readonly string[] | null,
  ): Promise<EntityMapSummary>;
  /** Which of `names` are the current entity name of some row. */
  abstract findTrackedNames(names: readonly string[]): Promise<Set<string>>;
  abstract findLogs(
    cargoId: string,
    limit: number,
  ): Promise<CargoEnvironmentalEntityLog[]>;
}

@Injectable()
export class TypeOrmEntitySyncStore extends EntitySyncStore {
  constructor(
    @InjectRepository(CargoEnvironmentalEntity)
    private readonly rows: Repository<CargoEnvironmentalEntity>,
    @InjectRepository(CargoEnvironmentalEntityLog)
    private readonly logs: Repository<CargoEnvironmentalEntityLog>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
  ) {
    super();
  }

  findByCargoId(cargoId: string): Promise<CargoEnvironmentalEntity | null> {
    return this.rows.findOne({ where: { cargoId } });
  }

  insert(row: NewEntityRow): Promise<CargoEnvironmentalEntity> {
    return this.rows.save(this.rows.create(row));
  }

  async update(id: string, patch: EntityRowPatch): Promise<void> {
    await this.rows.update({ id }, patch as never);
  }

  async updateIfDesired(
    id: string,
    desiredState: EntityDesiredState,
    patch: EntityRowPatch,
  ): Promise<boolean> {
    const result = await this.rows.update({ id, desiredState }, patch as never);
    return (result.affected ?? 0) > 0;
  }

  async updateMany(
    updates: { id: string; patch: EntityRowPatch }[],
  ): Promise<void> {
    await this.rows.manager.transaction(async (manager) => {
      for (const { id, patch } of updates) {
        await manager.update(CargoEnvironmentalEntity, { id }, patch as never);
      }
    });
  }

  async updateByIds(
    ids: readonly string[],
    patch: EntityRowPatch,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.rows.update({ id: In([...ids]) }, patch as never);
  }

  findDue(now: Date, limit: number): Promise<CargoEnvironmentalEntity[]> {
    const retryable: FindOptionsWhere<CargoEnvironmentalEntity>[] = [
      { syncStatus: In(OPEN_SYNC_STATUSES) },
      {
        syncStatus: EntitySyncStatus.FAILED,
        errorKind: EntitySyncErrorKind.RETRYABLE,
      },
    ];
    return this.rows.find({
      where: retryable.flatMap((condition) => [
        { ...condition, nextRetryAt: IsNull() },
        { ...condition, nextRetryAt: LessThanOrEqual(now) },
      ]),
      order: { updatedAt: 'ASC' },
      take: limit,
    });
  }

  findAll(): Promise<CargoEnvironmentalEntity[]> {
    return this.rows.find();
  }

  findByDesiredState(
    desiredState: EntityDesiredState,
  ): Promise<CargoEnvironmentalEntity[]> {
    return this.rows.find({ where: { desiredState } });
  }

  findByCargoIds(
    cargoIds: readonly string[],
  ): Promise<CargoEnvironmentalEntity[]> {
    if (cargoIds.length === 0) return Promise.resolve([]);
    return this.rows.find({ where: { cargoId: In([...cargoIds]) } });
  }

  /** Obstacles of exactly this map — rows without a map belong to no map and are never drawn. */
  findOnMap(mapRecordId: string | null): Promise<CargoEnvironmentalEntity[]> {
    if (!mapRecordId) return Promise.resolve([]);
    const onKernel: FindOptionsWhere<CargoEnvironmentalEntity>[] = [
      { desiredState: EntityDesiredState.PRESENT, mapRecordId },
      { syncStatus: Not(EntitySyncStatus.ACKED), mapRecordId },
    ];
    return this.rows.find({ where: onKernel, order: { createdAt: 'ASC' } });
  }

  async appendLog(entry: EntityLogEntry): Promise<void> {
    await this.logs.save(this.logs.create(entry as never));
  }

  async appendLogs(entries: readonly EntityLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.logs.insert(entries.map((entry) => entry as never));
  }

  findDeliveredCargoWithoutRow(limit: number): Promise<CargoEntity[]> {
    return this.cargoRepo
      .createQueryBuilder('cargo')
      .leftJoin(
        CargoEnvironmentalEntity,
        'entity',
        'entity.cargo_id = cargo.id',
      )
      .where('cargo.status = :delivered', { delivered: CargoStatus.DELIVERED })
      .andWhere('cargo.destination_location_name IS NOT NULL')
      .andWhere('cargo.map_record_id IS NOT NULL')
      .andWhere('entity.id IS NULL')
      .limit(limit)
      .getMany();
  }

  findCargosIncludingDeleted(
    cargoIds: readonly string[],
  ): Promise<CargoEntity[]> {
    if (cargoIds.length === 0) return Promise.resolve([]);
    return this.cargoRepo.find({
      where: { id: In([...cargoIds]) },
      withDeleted: true,
    });
  }

  async findLatestTaskId(cargoId: string): Promise<string | null> {
    const task = await this.taskRepo.findOne({
      where: { cargoId },
      order: { createdAt: 'DESC' },
      select: { id: true },
    });
    return task?.id ?? null;
  }

  async findLatestTaskIds(
    cargoIds: readonly string[],
  ): Promise<Map<string, string>> {
    const latest = await latestTaskByCargoId(this.taskRepo, cargoIds);
    return new Map(
      [...latest].map(([cargoId, task]) => [cargoId, task.id] as const),
    );
  }

  async findForAdmin(mapIds: string[] | null): Promise<EntityAdminRow[]> {
    if (mapIds !== null && mapIds.length === 0) return [];
    const entities = await this.rows.find({
      where: mapIds === null ? {} : { mapRecordId: In(mapIds) },
      order: { createdAt: 'DESC' },
    });
    const cargos = await this.findCargosIncludingDeleted(
      entities.map((entity) => entity.cargoId),
    );
    const cargoById = new Map(cargos.map((cargo) => [cargo.id, cargo]));
    return entities.map((entity) => ({
      entity,
      cargo: cargoById.get(entity.cargoId) ?? null,
    }));
  }

  async findAdminPage(
    query: EntityAdminPageQuery,
  ): Promise<{ rows: EntityAdminRow[]; total: number }> {
    if (query.mapIds !== null && query.mapIds.length === 0) {
      return { rows: [], total: 0 };
    }
    const builder = this.rows.createQueryBuilder('entity');
    if (query.mapIds !== null) {
      builder.andWhere('entity.map_record_id IN (:...mapIds)', {
        mapIds: query.mapIds,
      });
    }
    const search = query.search.trim();
    if (search) {
      builder.andWhere(
        `(entity.item_code ILIKE :search OR entity.entity_name ILIKE :search
          OR entity.destination_location_name ILIKE :search)`,
        { search: `%${search}%` },
      );
    }
    if (query.filters.length > 0) {
      builder.andWhere(
        new Brackets((any) => {
          for (const filter of query.filters) {
            if (filter === 'problem') {
              any.orWhere(new Brackets((where) => whereProblem(where, query)));
            } else {
              any.orWhere(`entity.desired_state = :${filter}State`, {
                [`${filter}State`]:
                  filter === 'present'
                    ? EntityDesiredState.PRESENT
                    : EntityDesiredState.RETIRED,
              });
            }
          }
        }),
      );
    }
    const [entities, total] = await builder
      .orderBy('entity.created_at', 'DESC')
      .addOrderBy('entity.id', 'DESC')
      .skip(query.offset)
      .take(query.limit)
      .getManyAndCount();
    const cargos = await this.findCargosIncludingDeleted(
      entities.map((entity) => entity.cargoId),
    );
    const cargoById = new Map(cargos.map((cargo) => [cargo.id, cargo]));
    return {
      rows: entities.map((entity) => ({
        entity,
        cargo: cargoById.get(entity.cargoId) ?? null,
      })),
      total,
    };
  }

  async summarizeMap(
    mapRecordId: string,
    kernelActiveNames: readonly string[] | null,
  ): Promise<EntityMapSummary> {
    const onMap = (): SelectQueryBuilder<CargoEnvironmentalEntity> =>
      this.rows
        .createQueryBuilder('entity')
        .where('entity.map_record_id = :mapRecordId', { mapRecordId });
    const [present, synced, problem] = await Promise.all([
      onMap()
        .andWhere('entity.desired_state = :present', {
          present: EntityDesiredState.PRESENT,
        })
        .getCount(),
      onMap()
        .andWhere('entity.desired_state = :present', {
          present: EntityDesiredState.PRESENT,
        })
        .andWhere('entity.sync_status = :acked', {
          acked: EntitySyncStatus.ACKED,
        })
        .getCount(),
      onMap()
        .andWhere(
          new Brackets((where) =>
            whereProblem(where, {
              loadedMapId: mapRecordId,
              kernelActiveNames,
            }),
          ),
        )
        .getCount(),
    ]);
    return { present, synced, problem };
  }

  async findTrackedNames(names: readonly string[]): Promise<Set<string>> {
    if (names.length === 0) return new Set();
    const rows = await this.rows.find({
      where: { entityName: In([...names]) },
      select: { entityName: true },
    });
    return new Set(rows.map((row) => row.entityName));
  }

  findLogs(
    cargoId: string,
    limit: number,
  ): Promise<CargoEnvironmentalEntityLog[]> {
    return this.logs.find({
      where: { cargoId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}

/**
 * "Something the operator should look at": the row is not confirmed, or — on the loaded map,
 * while the kernel can be read — WES and openTCS disagree about it.
 */
function whereProblem(
  where: WhereExpressionBuilder,
  { loadedMapId, kernelActiveNames }: KernelAgreement,
): void {
  where.where('entity.sync_status != :ackedStatus', {
    ackedStatus: EntitySyncStatus.ACKED,
  });
  if (!loadedMapId || kernelActiveNames === null) return;
  const params = {
    agreementMapId: loadedMapId,
    agreementPresent: EntityDesiredState.PRESENT,
    agreementRetired: EntityDesiredState.RETIRED,
    kernelActiveNames: [...kernelActiveNames],
  };
  if (kernelActiveNames.length === 0) {
    where.orWhere(
      'entity.map_record_id = :agreementMapId AND entity.desired_state = :agreementPresent',
      params,
    );
    return;
  }
  where.orWhere(
    `entity.map_record_id = :agreementMapId AND (
      (entity.desired_state = :agreementPresent AND entity.entity_name NOT IN (:...kernelActiveNames))
      OR (entity.desired_state = :agreementRetired AND entity.entity_name IN (:...kernelActiveNames))
    )`,
    params,
  );
}
