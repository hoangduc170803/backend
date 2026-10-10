import { randomUUID } from 'crypto';
import { AxiosError, type AxiosResponse } from 'axios';
import { CargoEntity, CargoStatus } from '../cargo/entities/cargo.entity';
import {
  CargoEnvironmentalEntity,
  EntityDesiredState,
  EntitySyncErrorKind,
  EntitySyncStatus,
} from './entities/cargo-environmental-entity.entity';
import type { CargoEnvironmentalEntityLog } from './entities/cargo-environmental-entity-log.entity';
import {
  EntitySyncStore,
  OPEN_SYNC_STATUSES,
  type EntityAdminPageQuery,
  type EntityAdminRow,
  type EntityLogEntry,
  type EntityMapSummary,
  type KernelAgreement,
  type EntityRowPatch,
  type NewEntityRow,
} from './entity-sync.store';
import { EntitySyncLock } from './entity-sync.lock';

export class InMemoryEntitySyncStore extends EntitySyncStore {
  readonly rows: CargoEnvironmentalEntity[] = [];
  readonly logs: EntityLogEntry[] = [];
  readonly cargos: CargoEntity[] = [];
  readonly latestTaskIds = new Map<string, string>();

  findByCargoId(cargoId: string): Promise<CargoEnvironmentalEntity | null> {
    const row = this.rows.find((candidate) => candidate.cargoId === cargoId);
    return Promise.resolve(row ? { ...row } : null);
  }

  insert(row: NewEntityRow): Promise<CargoEnvironmentalEntity> {
    if (this.rows.some((candidate) => candidate.cargoId === row.cargoId)) {
      return Promise.reject(
        new Error('duplicate key value violates unique constraint'),
      );
    }
    const now = new Date();
    const created: CargoEnvironmentalEntity = {
      id: randomUUID(),
      errorKind: null,
      attemptCount: 0,
      lastAttemptAt: null,
      nextRetryAt: null,
      ackedAt: null,
      lastError: null,
      sentEnvelope: null,
      sentPose: null,
      lastResponse: null,
      createdAt: now,
      updatedAt: now,
      ...row,
    };
    this.rows.push(created);
    return Promise.resolve({ ...created });
  }

  update(id: string, patch: EntityRowPatch): Promise<void> {
    this.apply((row) => row.id === id, patch);
    return Promise.resolve();
  }

  updateIfDesired(
    id: string,
    desiredState: EntityDesiredState,
    patch: EntityRowPatch,
  ): Promise<boolean> {
    return Promise.resolve(
      this.apply(
        (row) => row.id === id && row.desiredState === desiredState,
        patch,
      ) > 0,
    );
  }

  updateMany(updates: { id: string; patch: EntityRowPatch }[]): Promise<void> {
    for (const { id, patch } of updates) {
      this.apply((row) => row.id === id, patch);
    }
    return Promise.resolve();
  }

  findDue(now: Date, limit: number): Promise<CargoEnvironmentalEntity[]> {
    const due = this.rows
      .filter(
        (row) =>
          OPEN_SYNC_STATUSES.includes(row.syncStatus) ||
          (row.syncStatus === EntitySyncStatus.FAILED &&
            row.errorKind === EntitySyncErrorKind.RETRYABLE),
      )
      .filter((row) => !row.nextRetryAt || row.nextRetryAt <= now)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit);
    return Promise.resolve(due.map((row) => ({ ...row })));
  }

  findAll(): Promise<CargoEnvironmentalEntity[]> {
    return Promise.resolve(this.rows.map((row) => ({ ...row })));
  }

  findByDesiredState(
    desiredState: EntityDesiredState,
  ): Promise<CargoEnvironmentalEntity[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.desiredState === desiredState)
        .map((row) => ({ ...row })),
    );
  }

  findByCargoIds(
    cargoIds: readonly string[],
  ): Promise<CargoEnvironmentalEntity[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => cargoIds.includes(row.cargoId))
        .map((row) => ({ ...row })),
    );
  }

  findOnMap(mapRecordId: string | null): Promise<CargoEnvironmentalEntity[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            row.desiredState === EntityDesiredState.PRESENT ||
            row.syncStatus !== EntitySyncStatus.ACKED,
        )
        .filter((row) => !!mapRecordId && row.mapRecordId === mapRecordId)
        .map((row) => ({ ...row })),
    );
  }

  updateByIds(ids: readonly string[], patch: EntityRowPatch): Promise<void> {
    this.apply((row) => ids.includes(row.id), patch);
    return Promise.resolve();
  }

  appendLogs(entries: readonly EntityLogEntry[]): Promise<void> {
    this.logs.push(...entries);
    return Promise.resolve();
  }

  appendLog(entry: EntityLogEntry): Promise<void> {
    this.logs.push(entry);
    return Promise.resolve();
  }

  findDeliveredCargoWithoutRow(limit: number): Promise<CargoEntity[]> {
    return Promise.resolve(
      this.cargos
        .filter(
          (cargo) =>
            !cargo.deletedAt &&
            cargo.status === CargoStatus.DELIVERED &&
            cargo.destinationLocationName !== null &&
            cargo.mapRecordId !== null &&
            !this.rows.some((row) => row.cargoId === cargo.id),
        )
        .slice(0, limit),
    );
  }

  findCargosIncludingDeleted(
    cargoIds: readonly string[],
  ): Promise<CargoEntity[]> {
    return Promise.resolve(
      this.cargos.filter((cargo) => cargoIds.includes(cargo.id)),
    );
  }

  findLatestTaskIds(cargoIds: readonly string[]): Promise<Map<string, string>> {
    return Promise.resolve(
      new Map(
        cargoIds.flatMap((cargoId) => {
          const taskId = this.latestTaskIds.get(cargoId);
          return taskId ? [[cargoId, taskId] as const] : [];
        }),
      ),
    );
  }

  findLatestTaskId(cargoId: string): Promise<string | null> {
    return Promise.resolve(this.latestTaskIds.get(cargoId) ?? null);
  }

  findForAdmin(mapIds: string[] | null): Promise<EntityAdminRow[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            mapIds === null ||
            (row.mapRecordId !== null && mapIds.includes(row.mapRecordId)),
        )
        .map((row) => ({
          entity: { ...row },
          cargo: this.cargos.find((cargo) => cargo.id === row.cargoId) ?? null,
        })),
    );
  }

  async findAdminPage(
    query: EntityAdminPageQuery,
  ): Promise<{ rows: EntityAdminRow[]; total: number }> {
    const search = query.search.trim().toLowerCase();
    const matching = (await this.findForAdmin(query.mapIds))
      .filter(
        ({ entity }) =>
          !search ||
          [entity.itemCode, entity.entityName, entity.destinationLocationName]
            .filter((value): value is string => !!value)
            .some((value) => value.toLowerCase().includes(search)),
      )
      .filter(
        ({ entity }) =>
          query.filters.length === 0 ||
          query.filters.some((filter) =>
            filter === 'problem'
              ? isProblem(entity, query)
              : entity.desiredState ===
                (filter === 'present'
                  ? EntityDesiredState.PRESENT
                  : EntityDesiredState.RETIRED),
          ),
      )
      .sort(
        (a, b) => b.entity.createdAt.getTime() - a.entity.createdAt.getTime(),
      );
    return {
      rows: matching.slice(query.offset, query.offset + query.limit),
      total: matching.length,
    };
  }

  summarizeMap(
    mapRecordId: string,
    kernelActiveNames: readonly string[] | null,
  ): Promise<EntityMapSummary> {
    const onMap = this.rows.filter((row) => row.mapRecordId === mapRecordId);
    const present = onMap.filter(
      (row) => row.desiredState === EntityDesiredState.PRESENT,
    );
    return Promise.resolve({
      present: present.length,
      synced: present.filter((row) => row.syncStatus === EntitySyncStatus.ACKED)
        .length,
      problem: onMap.filter((row) =>
        isProblem(row, { loadedMapId: mapRecordId, kernelActiveNames }),
      ).length,
    });
  }

  findTrackedNames(names: readonly string[]): Promise<Set<string>> {
    return Promise.resolve(
      new Set(
        this.rows
          .map((row) => row.entityName)
          .filter((name) => names.includes(name)),
      ),
    );
  }

  findLogs(
    cargoId: string,
    limit: number,
  ): Promise<CargoEnvironmentalEntityLog[]> {
    return Promise.resolve(
      this.logs
        .filter((entry) => entry.cargoId === cargoId)
        .slice(-limit)
        .reverse()
        .map(
          (entry, index): CargoEnvironmentalEntityLog => ({
            ...entry,
            event: entry.event,
            id: String(index),
            createdAt: new Date(),
          }),
        ),
    );
  }

  row(cargoId: string): CargoEnvironmentalEntity {
    const row = this.rows.find((candidate) => candidate.cargoId === cargoId);
    if (!row) throw new Error(`no entity row for cargo ${cargoId}`);
    return row;
  }

  private apply(
    matches: (row: CargoEnvironmentalEntity) => boolean,
    patch: EntityRowPatch,
  ): number {
    const targets = this.rows.filter(matches);
    for (const row of targets) {
      Object.assign(row, patch, { updatedAt: new Date() });
    }
    return targets.length;
  }
}

export class InProcessEntitySyncLock extends EntitySyncLock {
  async run(_wait: boolean, work: () => Promise<void>): Promise<boolean> {
    await work();
    return true;
  }
}

export interface KernelPoint {
  name: string;
  x: number;
  y: number;
  z?: number;
  orientation?: number | 'NaN';
}

export interface StoredKernelEntity {
  name: string;
  retired: boolean;
  type: string;
  integrationLevel: string;
  properties: Record<string, string>;
  envelope: unknown;
  pose: unknown;
}

type KernelOperation =
  | 'list'
  | 'get'
  | 'create'
  | 'createAfterSuccess'
  | 'retire'
  | 'retireAfterSuccess';

export class FakeKernel {
  readonly entities = new Map<string, StoredKernelEntity>();
  readonly calls: { operation: string; name?: string; body?: unknown }[] = [];
  private readonly failures = new Map<KernelOperation, Error[]>();
  private points: KernelPoint[] = [];
  private locationPoints = new Map<string, string>();
  onCreate: ((name: string) => Promise<void>) | null = null;
  modelAvailable = true;

  withPoint(point: KernelPoint, locationName?: string): this {
    this.points.push(point);
    if (locationName) this.locationPoints.set(locationName, point.name);
    return this;
  }

  failNext(operation: KernelOperation, error: Error, times = 1): this {
    const queue = this.failures.get(operation) ?? [];
    for (let i = 0; i < times; i++) queue.push(error);
    this.failures.set(operation, queue);
    return this;
  }

  restart(): void {
    this.entities.clear();
  }

  seed(entity: Partial<StoredKernelEntity> & { name: string }): void {
    this.entities.set(entity.name, {
      retired: false,
      type: 'OBJECT',
      integrationLevel: 'TO_BE_RESPECTED',
      properties: {},
      envelope: null,
      pose: null,
      ...entity,
    });
  }

  callsOf(operation: string): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }

  invalidatePlantModelCache(): void {}

  getRawPlantModel(): Promise<unknown> {
    if (!this.modelAvailable) return Promise.resolve(null);
    return Promise.resolve({
      name: 'fake',
      points: this.points.map((point) => ({
        name: point.name,
        position: { x: point.x, y: point.y, z: point.z ?? 0 },
        vehicleOrientationAngle: point.orientation ?? 'NaN',
      })),
    });
  }

  findPointForLocation(locationName: string): Promise<string | null> {
    return Promise.resolve(this.locationPoints.get(locationName) ?? null);
  }

  listEnvironmentalEntities(): Promise<unknown[]> {
    this.calls.push({ operation: 'list' });
    this.throwIfFailing('list');
    return Promise.resolve([...this.entities.values()].map(clone));
  }

  getEnvironmentalEntity(name: string): Promise<unknown> {
    this.calls.push({ operation: 'get', name });
    this.throwIfFailing('get');
    const entity = this.entities.get(name);
    return Promise.resolve(entity ? clone(entity) : null);
  }

  async createEnvironmentalEntity(
    name: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ operation: 'create', name, body });
    this.throwIfFailing('create');
    if (this.entities.has(name)) {
      throw httpError(409, [`Object name already exists: ${name}`]);
    }
    const entity: StoredKernelEntity = {
      name,
      retired: false,
      type: body.type as string,
      integrationLevel: body.integrationLevel as string,
      properties: { ...(body.properties as Record<string, string>) },
      envelope: body.envelope,
      pose: body.pose,
    };
    this.entities.set(name, entity);
    if (this.onCreate) await this.onCreate(name);
    this.throwIfFailing('createAfterSuccess');
    return clone(entity);
  }

  retireEnvironmentalEntity(name: string): Promise<'RETIRED' | 'MISSING'> {
    this.calls.push({ operation: 'retire', name });
    this.throwIfFailing('retire');
    const entity = this.entities.get(name);
    if (!entity) return Promise.resolve('MISSING');
    entity.retired = true;
    this.throwIfFailing('retireAfterSuccess');
    return Promise.resolve('RETIRED');
  }

  private throwIfFailing(operation: KernelOperation): void {
    const error = this.failures.get(operation)?.shift();
    if (error) throw error;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function httpError(status: number, data: unknown = null): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    undefined,
    undefined,
    { status, data, statusText: '', headers: {}, config: {} } as AxiosResponse,
  );
}

export function timeoutError(): AxiosError {
  return new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED');
}

export function connectionRefused(): AxiosError {
  return new AxiosError('connect ECONNREFUSED 127.0.0.1:55200', 'ECONNREFUSED');
}

export function deliveredCargo(
  overrides: Partial<CargoEntity> = {},
): CargoEntity {
  return {
    id: randomUUID(),
    itemCode: 'ITEM-1',
    sourcePointName: 'S1',
    sourcePickupLocationName: 'location_S1',
    destinationLocationName: 'location_D1',
    reservedLocationName: null,
    slotDecisionSeq: 0,
    sourceZoneId: null,
    destinationZoneId: null,
    mapRecordId: 'map-a',
    status: CargoStatus.DELIVERED,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deliveredAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function isProblem(
  row: CargoEnvironmentalEntity,
  { loadedMapId, kernelActiveNames }: KernelAgreement,
): boolean {
  if (row.syncStatus !== EntitySyncStatus.ACKED) return true;
  if (!loadedMapId || kernelActiveNames === null) return false;
  if (row.mapRecordId !== loadedMapId) return false;
  const active = kernelActiveNames.includes(row.entityName);
  return row.desiredState === EntityDesiredState.PRESENT ? !active : active;
}
