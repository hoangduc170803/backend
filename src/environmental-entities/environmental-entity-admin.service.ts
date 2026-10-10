import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MapRecordEntity } from '../maps/infrastructure/entities/map-record.entity';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { resolveMapFilter } from '../maps/domain/map-scope';
import {
  ENTITY_ADMIN_FILTERS,
  EntitySyncStore,
  type EntityAdminFilter,
  type EntityAdminRow,
  type EntityMapSummary,
} from './entity-sync.store';
import {
  EnvironmentalEntitySyncService,
  toSyncView,
} from './environmental-entity-sync.service';
import { obstacleIneligibility } from './domain/obstacle-eligibility';
import {
  CARGO_ID_PROPERTY,
  isWesOwned,
  type KernelEnvironmentalEntity,
} from './domain/entity-sync.policy';
import { isEpochMarker } from './domain/kernel-entity-kind';
import type { ObstacleAdminQueryDto } from './environmental-entity.dto';
import type {
  EnvironmentalEntityAdminListDto,
  EnvironmentalEntityAdminRowDto,
  EnvironmentalEntityLogDto,
  KernelEntityState,
  KernelOnlyEntityDto,
} from './environmental-entity.dto';

const LOG_LIMIT = 200;
const DEFAULT_PAGE_SIZE = 20;
const KERNEL_ENTITIES_TTL_MS = 5_000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function listOf(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Read model of the admin obstacle table: WES rows, their live kernel state, and kernel-only entities. */
@Injectable()
export class EnvironmentalEntityAdminService {
  constructor(
    private readonly store: EntitySyncStore,
    private readonly sync: EnvironmentalEntitySyncService,
    private readonly activeMap: ActiveMapContext,
    @InjectRepository(MapRecordEntity)
    private readonly mapRepo: Repository<MapRecordEntity>,
  ) {}

  private kernelCache: {
    at: number;
    entities: KernelEnvironmentalEntity[] | null;
  } | null = null;

  /** One page of the table (20 rows by default), newest first; filters and search run in SQL. */
  async list(
    query: ObstacleAdminQueryDto,
    userMapIds: string[] | undefined,
  ): Promise<EnvironmentalEntityAdminListDto> {
    const loadedMapId = await this.activeMap.id();
    const filter = resolveMapFilter(query, loadedMapId, userMapIds);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const kernel = await this.kernelEntities();

    const { rows, total } = await this.store.findAdminPage({
      mapIds: narrowTo(filter.ids, listOf(query.mapRecordIds).filter(isUuid)),
      filters: listOf(query.filters).filter(isAdminFilter),
      search: query.search ?? '',
      loadedMapId,
      kernelActiveNames: kernel && activeNamesOf(kernel),
      offset: (page - 1) * limit,
      limit,
    });
    const kernelByName = new Map(
      (kernel ?? []).map((entity) => [entity.name, entity]),
    );
    const mapNames = await this.mapNamesOf(rows);

    const loadedInScope =
      loadedMapId !== null &&
      (filter.ids === null || filter.ids.includes(loadedMapId));

    return {
      loadedMapId,
      kernelReachable: kernel !== null,
      rows: rows.map((row) =>
        toAdminRow(row, loadedMapId, kernel && kernelByName, mapNames),
      ),
      total,
      page,
      limit,
      kernelOnly:
        kernel && loadedInScope && page === 1
          ? await this.kernelOnlyEntities(kernel)
          : [],
    };
  }

  /** Counters of the loaded map's obstacles — what the status bar and the dock tab badge show. */
  async summaryOf(mapRecordId: string | null): Promise<EntityMapSummary> {
    if (!mapRecordId) return { present: 0, synced: 0, problem: 0 };
    const kernel = await this.kernelEntities();
    return this.store.summarizeMap(
      mapRecordId,
      kernel && activeNamesOf(kernel),
    );
  }

  private async kernelEntities(): Promise<KernelEnvironmentalEntity[] | null> {
    const cached = this.kernelCache;
    if (cached && Date.now() - cached.at < KERNEL_ENTITIES_TTL_MS) {
      return cached.entities;
    }
    let entities: KernelEnvironmentalEntity[] | null;
    try {
      entities = await this.sync.kernelEntities();
    } catch {
      entities = null;
    }
    this.kernelCache = { at: Date.now(), entities };
    return entities;
  }

  /** Active kernel entities that no WES row currently stands for (the row's current name). */
  private async kernelOnlyEntities(
    kernel: readonly KernelEnvironmentalEntity[],
  ): Promise<KernelOnlyEntityDto[]> {
    const candidates = kernel.filter(
      (entity) => !entity.retired && !isEpochMarker(entity.name),
    );
    const tracked = await this.store.findTrackedNames(
      candidates.map((entity) => entity.name),
    );
    return candidates
      .filter((entity) => !tracked.has(entity.name))
      .map((entity) => ({
        name: entity.name,
        retired: entity.retired,
        type: entity.type ?? null,
        integrationLevel: entity.integrationLevel ?? null,
        wesOwned: isWesOwned(entity),
        cargoId: entity.properties[CARGO_ID_PROPERTY] ?? null,
        properties: entity.properties,
      }));
  }

  async logs(cargoId: string): Promise<EnvironmentalEntityLogDto[]> {
    const logs = await this.store.findLogs(cargoId, LOG_LIMIT);
    return logs.map((log) => ({
      event: log.event,
      entityName: log.entityName,
      detail: log.detail,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  private async mapNamesOf(
    rows: readonly EntityAdminRow[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows.flatMap(({ entity }) =>
          entity.mapRecordId ? [entity.mapRecordId] : [],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const maps = await this.mapRepo.find({
      where: { id: In(ids) },
      select: { id: true, name: true },
      withDeleted: true,
    });
    return new Map(maps.map((map) => [map.id, map.name]));
  }
}

function toAdminRow(
  { entity, cargo }: EntityAdminRow,
  loadedMapId: string | null,
  kernelByName: Map<string, KernelEnvironmentalEntity> | null,
  mapNames: Map<string, string>,
): EnvironmentalEntityAdminRowDto {
  const onLoadedMap =
    entity.mapRecordId !== null && entity.mapRecordId === loadedMapId;
  return {
    ...toSyncView(entity),
    cargoId: entity.cargoId,
    itemCode: entity.itemCode,
    destinationLocationName: entity.destinationLocationName,
    mapRecordId: entity.mapRecordId,
    mapName: entity.mapRecordId
      ? (mapNames.get(entity.mapRecordId) ?? null)
      : null,
    onLoadedMap,
    cargoStatus: cargo?.status ?? null,
    cargoDeleted: !cargo || !!cargo.deletedAt,
    ineligibleReason: obstacleIneligibility(cargo),
    kernelState: kernelStateOf(entity.entityName, onLoadedMap, kernelByName),
    pose: entity.sentPose,
    envelope: entity.sentEnvelope,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

function kernelStateOf(
  name: string,
  onLoadedMap: boolean,
  kernelByName: Map<string, KernelEnvironmentalEntity> | null,
): KernelEntityState {
  if (!onLoadedMap) return 'NOT_LOADED';
  if (!kernelByName) return 'UNKNOWN';
  const entity = kernelByName.get(name);
  if (!entity) return 'MISSING';
  return entity.retired ? 'RETIRED' : 'ACTIVE';
}

function activeNamesOf(kernel: readonly KernelEnvironmentalEntity[]): string[] {
  return kernel
    .filter((entity) => !entity.retired)
    .map((entity) => entity.name);
}

function isUuid(value: string): boolean {
  return UUID.test(value);
}

function isAdminFilter(value: string): value is EntityAdminFilter {
  return (ENTITY_ADMIN_FILTERS as readonly string[]).includes(value);
}

/** The scope's maps narrowed to the ones picked in the table's map filter (empty = no pick). */
function narrowTo(
  scopeIds: string[] | null,
  picked: readonly string[],
): string[] | null {
  if (picked.length === 0) return scopeIds;
  return scopeIds === null
    ? [...picked]
    : scopeIds.filter((id) => picked.includes(id));
}
