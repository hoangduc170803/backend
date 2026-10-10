import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { ActiveMapRecordService } from '../maps/infrastructure/active-map-record.service';
import { CargoEntity, CargoStatus } from '../cargo/entities/cargo.entity';
import {
  ENVIRONMENTAL_ENTITY_EVENTS,
  FMS_EVENTS,
} from '../cargo/domain/events';
import {
  CargoEnvironmentalEntity,
  EntityDesiredState,
  EntitySyncErrorKind,
  EntitySyncStatus,
} from './entities/cargo-environmental-entity.entity';
import type { EntitySyncLogEvent } from './entities/cargo-environmental-entity-log.entity';
import {
  cargoFootprintFromEnv,
  centeredEnvelope,
  envelopeProblem,
  pointPoseSourceFromRawModel,
  poseAtPoint,
  type CargoFootprint,
} from './domain/cargo-geometry';
import {
  CARGO_ID_PROPERTY,
  EntitySyncError,
  backoffMs,
  classifyKernelError,
  entityNameFor,
  entitySyncConfigFromEnv,
  httpStatusOf,
  isCreateAck,
  isWesOwned,
  matchEntity,
  toKernelEntity,
  type EntitySyncConfig,
  type KernelEnvironmentalEntity,
} from './domain/entity-sync.policy';
import { EntitySyncStore, type EntityRowPatch } from './entity-sync.store';
import { obstacleIneligibility } from './domain/obstacle-eligibility';
import { isEpochMarker } from './domain/kernel-entity-kind';
import { EntitySyncLock } from './entity-sync.lock';
import type {
  EntitySyncView,
  EnvironmentalEntityOverlayDto,
} from './environmental-entity.dto';

const BATCH_SIZE = 20;
const MAP_NOT_LOADED_RETRY_MS = 30_000;
const MAX_GENERATION_BUMPS_PER_ATTEMPT = 3;
const RECONCILE_BATCH_SIZE = 100;

class DesiredStateChanged extends Error {}

@Injectable()
export class EnvironmentalEntitySyncService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(EnvironmentalEntitySyncService.name);
  private readonly config: EntitySyncConfig = entitySyncConfigFromEnv();
  private readonly footprint: CargoFootprint = cargoFootprintFromEnv();
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private passQueued = false;
  private lastDriftCheckAt = 0;
  private resyncReason: string | null = null;

  constructor(
    private readonly store: EntitySyncStore,
    private readonly lock: EntitySyncLock,
    private readonly kernelApi: KernelApiService,
    private readonly activeMap: ActiveMapContext,
    private readonly activeMapRecords: ActiveMapRecordService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    if (process.env.ENTITY_SYNC_ENABLED === 'false') {
      this.logger.warn(
        'ENTITY_SYNC_ENABLED=false — delivered cargo is not synced to FMS',
      );
      return;
    }
    this.timer = setInterval(() => this.kick(), this.config.tickMs);
    this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get cargoFootprint(): CargoFootprint {
    return this.footprint;
  }

  async markPresent(
    cargo: CargoEntity,
    taskId: string | null,
  ): Promise<CargoEnvironmentalEntity> {
    const existing = await this.store.findByCargoId(cargo.id);
    if (existing) return existing;

    let row: CargoEnvironmentalEntity;
    try {
      row = await this.store.insert({
        cargoId: cargo.id,
        taskId,
        mapRecordId: cargo.mapRecordId,
        itemCode: cargo.itemCode,
        destinationLocationName: cargo.destinationLocationName,
        generation: 1,
        entityName: entityNameFor(cargo.id, 1),
        desiredState: EntityDesiredState.PRESENT,
        syncStatus: EntitySyncStatus.PENDING,
      });
    } catch (err) {
      const raced = await this.store.findByCargoId(cargo.id);
      if (raced) return raced;
      throw err;
    }
    await this.audit(row, 'DESIRED_PRESENT', 'Hàng đã giao — cần tạo vật cản');
    this.changed(row.cargoId);
    this.kick();
    return row;
  }

  async markRetired(
    cargoId: string,
    reason: string,
  ): Promise<CargoEnvironmentalEntity | null> {
    await this.markRetiredMany([cargoId], reason);
    return this.store.findByCargoId(cargoId);
  }

  async markRetiredMany(
    cargoIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const rows = (await this.store.findByCargoIds(cargoIds)).filter(
      (row) => row.desiredState === EntityDesiredState.PRESENT,
    );
    if (rows.length === 0) return;

    await this.store.updateByIds(
      rows.map((row) => row.id),
      {
        desiredState: EntityDesiredState.RETIRED,
        syncStatus: EntitySyncStatus.PENDING,
        errorKind: null,
        lastError: null,
        attemptCount: 0,
        nextRetryAt: null,
      },
    );
    await this.store
      .appendLogs(
        rows.map((row) => ({
          cargoId: row.cargoId,
          entityName: row.entityName,
          event: 'DESIRED_RETIRED' as const,
          detail: reason,
          payload: null,
        })),
      )
      .catch((err: Error) =>
        this.logger.error(
          `Could not audit ${rows.length} obstacle retirement(s): ${err.message}`,
        ),
      );
    this.changed(rows.length === 1 ? rows[0].cargoId : null);
    this.kick();
  }

  async retryNow(cargoId: string): Promise<EntitySyncView> {
    const row = await this.store.findByCargoId(cargoId);
    if (!row) {
      throw new NotFoundException('Hàng này chưa có vật cản trên FMS.');
    }
    await this.store.update(row.id, {
      syncStatus: EntitySyncStatus.PENDING,
      errorKind: null,
      attemptCount: 0,
      nextRetryAt: null,
    });
    await this.audit(row, 'MANUAL_RETRY', 'Người vận hành yêu cầu thử lại');
    await this.syncNow().catch((err: Error) =>
      this.logger.warn(`Manual retry pass failed: ${err.message}`),
    );
    const after = await this.store.findByCargoId(cargoId);
    this.changed(cargoId);
    return toSyncView(after ?? row);
  }

  async fullResync(reason: string): Promise<void> {
    this.resyncReason = reason;
    await this.syncNow();
  }

  syncNow(): Promise<void> {
    return this.runPass(true);
  }

  kick(): void {
    if (this.passQueued) return;
    this.passQueued = true;
    void this.runPass(false).catch((err: Error) =>
      this.logger.warn(`Environmental entity sync pass failed: ${err.message}`),
    );
  }

  async settled(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.chain;
      await observed;
    } while (observed !== this.chain);
  }

  @OnEvent(FMS_EVENTS.KERNEL_CONNECTED)
  onKernelConnected(): void {
    this.lastDriftCheckAt = 0;
    this.kick();
  }

  async viewsByCargoIds(
    cargoIds: readonly string[],
  ): Promise<Map<string, EntitySyncView>> {
    const rows = await this.store.findByCargoIds(cargoIds);
    return new Map(rows.map((row) => [row.cargoId, toSyncView(row)]));
  }

  async overlayFor(
    mapRecordId: string | null,
  ): Promise<EnvironmentalEntityOverlayDto[]> {
    if (!mapRecordId) return [];
    const rows = await this.store.findOnMap(mapRecordId);
    return rows.map((row) => ({
      ...toSyncView(row),
      cargoId: row.cargoId,
      itemCode: row.itemCode,
      destinationLocationName: row.destinationLocationName,
      pose: row.sentPose,
      envelope: row.sentEnvelope,
    }));
  }

  private runPass(waitForLock: boolean): Promise<void> {
    const pass = this.chain.then(async () => {
      this.passQueued = false;
      await this.lock.run(waitForLock, () => this.passLocked());
    });
    this.chain = pass.catch(() => undefined);
    return pass;
  }

  private async passLocked(): Promise<void> {
    let freshMapId: string | null | undefined;
    if (this.resyncReason) {
      await this.fullResyncLocked(this.resyncReason);
      freshMapId = await this.activeMapRecords.resolveId();
    }
    if (Date.now() - this.lastDriftCheckAt >= this.config.driftCheckMs) {
      this.lastDriftCheckAt = Date.now();
      await this.reconcileDesiredStates();
      await this.checkDriftLocked();
    }
    await this.processDue(freshMapId);
  }

  // ── Operator actions (admin obstacle table) ────────────────────────────────

  /** Retires a WES obstacle on the operator's request. It stays retired: reconcile never
   *  re-creates a row that already exists, it only retires ones whose cargo stopped qualifying. */
  async retireManually(
    cargoId: string,
    actor: string,
  ): Promise<CargoEnvironmentalEntity> {
    const row = await this.requireRow(cargoId);
    if (row.desiredState === EntityDesiredState.RETIRED) {
      throw new ConflictException('Vật cản này đã được retire.');
    }
    await this.markRetired(cargoId, `Retire thủ công bởi ${actor}`);
    await this.audit(row, 'MANUAL_RETIRE', `Retire thủ công bởi ${actor}`);
    await this.syncNow().catch((err: Error) =>
      this.logger.warn(`Manual retire pass failed: ${err.message}`),
    );
    return this.requireRow(cargoId);
  }

  /** Puts a retired obstacle back. Only for cargo that still qualifies — otherwise the next
   *  reconcile would retire it again within seconds. */
  async reactivateManually(
    cargoId: string,
    actor: string,
  ): Promise<CargoEnvironmentalEntity> {
    const row = await this.requireRow(cargoId);
    if (row.desiredState === EntityDesiredState.PRESENT) {
      throw new ConflictException('Vật cản này đang hoạt động.');
    }
    const [cargo] = await this.store.findCargosIncludingDeleted([cargoId]);
    const reason = obstacleIneligibility(cargo ?? null);
    if (reason) {
      throw new ConflictException(`Không thể kích hoạt lại: ${reason}.`);
    }
    const patch: EntityRowPatch = {
      desiredState: EntityDesiredState.PRESENT,
      syncStatus: EntitySyncStatus.PENDING,
      errorKind: null,
      lastError: null,
      attemptCount: 0,
      nextRetryAt: null,
    };
    await this.store.update(row.id, patch);
    Object.assign(row, patch);
    await this.audit(row, 'MANUAL_REACTIVATE', `Kích hoạt lại bởi ${actor}`);
    this.changed(cargoId);
    await this.syncNow().catch((err: Error) =>
      this.logger.warn(`Reactivation pass failed: ${err.message}`),
    );
    return this.requireRow(cargoId);
  }

  /**
   * Retires an entity straight on the kernel by name — for obstacles WES has no row for
   * (created by hand, by another system, or orphaned). A WES-tracked entity must go through
   * `retireManually` so the row and the kernel stay in step.
   */
  async retireKernelEntity(name: string, actor: string): Promise<void> {
    if (isEpochMarker(name)) {
      throw new ConflictException(
        'Đây là mốc phiên kernel của WES, không phải vật cản.',
      );
    }
    const entity = (await this.listKernelEntities()).find(
      (candidate) => candidate.name === name,
    );
    if (!entity) {
      throw new NotFoundException(`Không có entity ${name} trên FMS.`);
    }
    const cargoId = entity.properties[CARGO_ID_PROPERTY];
    const row = cargoId ? await this.store.findByCargoId(cargoId) : null;
    if (
      row &&
      row.entityName === name &&
      row.desiredState === EntityDesiredState.PRESENT
    ) {
      throw new ConflictException(
        'Entity này do WES quản lý — hãy retire từ dòng vật cản tương ứng.',
      );
    }
    if (entity.retired) return;
    await this.kernelApi.retireEnvironmentalEntity(name);
    await this.store.appendLog({
      cargoId: row?.cargoId ?? null,
      entityName: name,
      event: 'KERNEL_RETIRE',
      detail: `Retire trực tiếp trên FMS bởi ${actor}`,
      payload: entity,
    });
    this.changed(row?.cargoId ?? null);
  }

  kernelEntities(): Promise<KernelEnvironmentalEntity[]> {
    return this.listKernelEntities();
  }

  private async requireRow(cargoId: string): Promise<CargoEnvironmentalEntity> {
    const row = await this.store.findByCargoId(cargoId);
    if (!row) throw new NotFoundException('Hàng này không có vật cản.');
    return row;
  }

  private async processDue(knownMapId?: string | null): Promise<void> {
    const due = await this.store.findDue(new Date(), BATCH_SIZE);
    if (due.length === 0) return;

    const activeMapId =
      knownMapId !== undefined ? knownMapId : await this.activeMap.id();
    for (const row of due) {
      await this.processRow(row, activeMapId);
    }
  }

  private async processRow(
    row: CargoEnvironmentalEntity,
    activeMapId: string | null,
  ): Promise<void> {
    try {
      if (this.waitsForItsMap(row, activeMapId)) {
        await this.patch(row, {
          syncStatus: EntitySyncStatus.PENDING,
          lastError:
            row.mapRecordId === null
              ? 'Hàng không gắn bản đồ — không đặt vật cản'
              : 'Bản đồ của hàng này chưa được nạp vào FMS',
          nextRetryAt: new Date(Date.now() + MAP_NOT_LOADED_RETRY_MS),
        });
        return;
      }

      await this.patch(row, {
        syncStatus: EntitySyncStatus.SENDING,
        attemptCount: row.attemptCount + 1,
        lastAttemptAt: new Date(),
      });

      if (row.desiredState === EntityDesiredState.PRESENT) {
        await this.ensurePresent(row);
      } else {
        await this.ensureRetired(row);
      }
    } catch (err) {
      await this.handleFailure(row, err);
    }
  }

  /**
   * A wanted obstacle is only ever sent to the map it was delivered on. A row without a map
   * (legacy cargo from before map scoping) has no map to wait for: it must never reach the
   * kernel, where its location name would resolve against whatever map happens to be loaded.
   */
  private waitsForItsMap(
    row: CargoEnvironmentalEntity,
    activeMapId: string | null,
  ): boolean {
    return (
      row.desiredState === EntityDesiredState.PRESENT &&
      (row.mapRecordId === null || row.mapRecordId !== activeMapId)
    );
  }

  private async handleFailure(
    row: CargoEnvironmentalEntity,
    err: unknown,
  ): Promise<void> {
    if (err instanceof DesiredStateChanged) {
      this.kick();
      return;
    }
    try {
      await this.recordFailure(row, classifyKernelError(err));
    } catch (persistErr) {
      if (persistErr instanceof DesiredStateChanged) {
        this.kick();
        return;
      }
      this.logger.error(
        `Could not record the entity sync failure of cargo ${row.cargoId}: ${(persistErr as Error).message}`,
      );
    }
  }

  private async ensurePresent(row: CargoEnvironmentalEntity): Promise<void> {
    for (let bump = 0; bump < MAX_GENERATION_BUMPS_PER_ATTEMPT; bump++) {
      const existing = await this.fetchEntity(row.entityName);
      switch (matchEntity(existing, row.cargoId)) {
        case 'ACTIVE_OWNED':
          return this.ack(row, existing, 'Entity đúng hàng đã có trên FMS');
        case 'FOREIGN':
          throw foreignEntityError(row.entityName, existing);
        case 'RETIRED_OWNED':
          await this.bumpGeneration(row, 'Entity cũ đã bị retire trên FMS');
          continue;
        case 'MISSING':
          return this.create(row);
      }
    }
    throw new EntitySyncError(
      'Không chọn được tên entity hợp lệ sau nhiều lần tăng generation',
      EntitySyncErrorKind.RETRYABLE,
    );
  }

  private async create(row: CargoEnvironmentalEntity): Promise<void> {
    const body = await this.buildCreateRequest(row);
    await this.audit(row, 'SEND_CREATE', `POST ${row.entityName}`, body);

    let raw: unknown;
    try {
      raw = await this.kernelApi.createEnvironmentalEntity(
        row.entityName,
        body,
      );
    } catch (err) {
      if (httpStatusOf(err) !== 409) throw err;
      return this.resolveNameConflict(row);
    }

    const created = toKernelEntity(raw);
    if (!isCreateAck(created, row.entityName, row.cargoId)) {
      throw new EntitySyncError(
        'Phản hồi CREATE từ FMS không đầy đủ hoặc không khớp',
        EntitySyncErrorKind.RETRYABLE,
      );
    }
    await this.ack(row, created, 'FMS xác nhận đã tạo entity');
  }

  private async resolveNameConflict(
    row: CargoEnvironmentalEntity,
  ): Promise<void> {
    const existing = await this.fetchEntity(row.entityName);
    switch (matchEntity(existing, row.cargoId)) {
      case 'ACTIVE_OWNED':
        return this.ack(
          row,
          existing,
          'CREATE trả 409 nhưng entity đúng hàng đã tồn tại',
        );
      case 'FOREIGN':
        throw foreignEntityError(row.entityName, existing);
      case 'RETIRED_OWNED':
        await this.bumpGeneration(row, 'CREATE trả 409, entity cũ đã retire');
        throw new EntitySyncError(
          'Entity cũ đã retire — sẽ tạo lại với generation mới',
          EntitySyncErrorKind.RETRYABLE,
          409,
        );
      case 'MISSING':
        throw new EntitySyncError(
          'FMS báo trùng tên nhưng không tìm thấy entity',
          EntitySyncErrorKind.RETRYABLE,
          409,
        );
    }
  }

  private async ensureRetired(row: CargoEnvironmentalEntity): Promise<void> {
    const existing = await this.fetchEntity(row.entityName);
    switch (matchEntity(existing, row.cargoId)) {
      case 'MISSING':
        return this.ack(
          row,
          null,
          'Entity không còn trên FMS (chưa từng tạo hoặc đã được dọn)',
        );
      case 'FOREIGN':
        throw foreignEntityError(row.entityName, existing);
      case 'RETIRED_OWNED':
        return this.ack(row, existing, 'Entity đã được retire từ trước');
      case 'ACTIVE_OWNED':
        break;
    }

    await this.audit(row, 'SEND_RETIRE', `PUT ${row.entityName}/retired`);
    await this.kernelApi.retireEnvironmentalEntity(row.entityName);
    const after = await this.fetchEntity(row.entityName);
    if (after && !after.retired) {
      throw new EntitySyncError(
        'FMS chưa xác nhận entity đã retire',
        EntitySyncErrorKind.RETRYABLE,
      );
    }
    await this.ack(row, after, 'FMS xác nhận entity đã retire');
  }

  private async buildCreateRequest(
    row: CargoEnvironmentalEntity,
  ): Promise<Record<string, unknown>> {
    if (!row.destinationLocationName) {
      throw new EntitySyncError(
        'Hàng không có vị trí giao — không xác định được vị trí vật cản',
        EntitySyncErrorKind.FATAL,
      );
    }
    this.kernelApi.invalidatePlantModelCache();
    const rawModel = await this.kernelApi.getRawPlantModel();
    if (!rawModel) {
      throw new EntitySyncError(
        'Không đọc được plant model từ FMS',
        EntitySyncErrorKind.RETRYABLE,
      );
    }
    const pointName = await this.kernelApi.findPointForLocation(
      row.destinationLocationName,
    );
    if (!pointName) {
      throw new EntitySyncError(
        `Vị trí giao ${row.destinationLocationName} không có point trên plant model`,
        EntitySyncErrorKind.FATAL,
      );
    }
    const source = pointPoseSourceFromRawModel(rawModel, pointName);
    const posed = source ? poseAtPoint(source) : null;
    if (!posed) {
      throw new EntitySyncError(
        `Pose của point ${pointName} không hợp lệ`,
        EntitySyncErrorKind.FATAL,
      );
    }
    const envelope = centeredEnvelope(this.footprint);
    const problem = envelopeProblem(envelope);
    if (problem) throw new EntitySyncError(problem, EntitySyncErrorKind.FATAL);

    await this.patch(row, { sentEnvelope: envelope, sentPose: posed.pose });

    return {
      envelope,
      pose: posed.pose,
      type: 'OBJECT',
      integrationLevel: 'TO_BE_RESPECTED',
      layout: { layerId: 0 },
      incompleteName: false,
      properties: {
        [CARGO_ID_PROPERTY]: row.cargoId,
        'wes:itemCode': row.itemCode,
        'wes:taskId': row.taskId ?? '',
        'wes:mapRecordId': row.mapRecordId ?? '',
        'wes:destinationLocation': row.destinationLocationName,
        'wes:destinationPoint': pointName,
        'wes:status': CargoStatus.DELIVERED,
        'wes:generation': String(row.generation),
        'wes:orientationSource': posed.orientationSource,
      },
    };
  }

  private async fetchEntity(
    name: string,
  ): Promise<KernelEnvironmentalEntity | null> {
    const raw = await this.kernelApi.getEnvironmentalEntity(name);
    if (raw === null) return null;
    const entity = toKernelEntity(raw);
    if (!entity) {
      throw new EntitySyncError(
        `Phản hồi GET ${name} từ FMS không đầy đủ`,
        EntitySyncErrorKind.RETRYABLE,
      );
    }
    return entity;
  }

  private async ack(
    row: CargoEnvironmentalEntity,
    entity: KernelEnvironmentalEntity | null,
    detail: string,
  ): Promise<void> {
    await this.patch(row, {
      syncStatus: EntitySyncStatus.ACKED,
      ackedAt: new Date(),
      errorKind: null,
      lastError: null,
      nextRetryAt: null,
      lastResponse: entity ?? { missing: true },
    });
    await this.audit(row, 'ACK', detail, entity);
    // A new generation just landed: let the next pass retire its predecessor right away.
    if (row.desiredState === EntityDesiredState.PRESENT && row.generation > 1) {
      this.lastDriftCheckAt = 0;
      this.kick();
    }
    this.logger.log(
      `Cargo ${row.cargoId}: ${row.desiredState} ${row.entityName} ACKED — ${detail}`,
    );
    this.changed(row.cargoId);
  }

  private async recordFailure(
    row: CargoEnvironmentalEntity,
    error: EntitySyncError,
  ): Promise<void> {
    const fatal = error.kind === EntitySyncErrorKind.FATAL;
    const exhausted = row.attemptCount >= this.config.maxAttempts;
    const status =
      fatal || exhausted ? EntitySyncStatus.FAILED : EntitySyncStatus.RETRYING;
    const nextRetryAt = fatal
      ? null
      : new Date(Date.now() + backoffMs(row.attemptCount, this.config));

    await this.patch(row, {
      syncStatus: status,
      errorKind: error.kind,
      lastError: error.message,
      nextRetryAt,
    });
    await this.audit(
      row,
      status === EntitySyncStatus.FAILED ? 'FAILED' : 'RETRY',
      error.message,
      { status: error.status, attempt: row.attemptCount, nextRetryAt },
    );
    this.logger.warn(
      `Cargo ${row.cargoId}: ${row.desiredState} ${row.entityName} ${status} (${error.kind}, attempt ${row.attemptCount}) — ${error.message}`,
    );
    this.changed(row.cargoId);
  }

  private async bumpGeneration(
    row: CargoEnvironmentalEntity,
    reason: string,
  ): Promise<void> {
    const generation = row.generation + 1;
    await this.patch(row, {
      generation,
      entityName: entityNameFor(row.cargoId, generation),
    });
    await this.audit(row, 'GENERATION_BUMPED', reason);
  }

  private async patch(
    row: CargoEnvironmentalEntity,
    patch: EntityRowPatch,
  ): Promise<void> {
    const applied = await this.store.updateIfDesired(
      row.id,
      row.desiredState,
      patch,
    );
    if (!applied) throw new DesiredStateChanged();
    Object.assign(row, patch);
  }

  /**
   * The plant model was replaced: every obstacle of the loaded map is re-posed against the new
   * model under a fresh generation. Make-before-break — the old entities stay on the kernel until
   * their successor is acknowledged, then the drift repair retires them, so vehicles never see a
   * window without the obstacle.
   */
  private async fullResyncLocked(reason: string): Promise<void> {
    const activeMapId = await this.activeMapRecords.resolveId();
    const rows = activeMapId
      ? (
          await this.store.findByDesiredState(EntityDesiredState.PRESENT)
        ).filter((row) => row.mapRecordId === activeMapId)
      : [];
    await this.store.updateMany(
      rows.map((row) => {
        const generation = row.generation + 1;
        return {
          id: row.id,
          patch: {
            generation,
            entityName: entityNameFor(row.cargoId, generation),
            syncStatus: EntitySyncStatus.PENDING,
            errorKind: null,
            lastError: null,
            attemptCount: 0,
            nextRetryAt: null,
          },
        };
      }),
    );
    this.resyncReason = null;
    this.lastDriftCheckAt = 0;

    await this.store
      .appendLog({
        cargoId: null,
        entityName: null,
        event: 'FULL_RESYNC',
        detail: reason,
        payload: { mapRecordId: activeMapId, recreating: rows.length },
      })
      .catch((err: Error) =>
        this.logger.error(`Could not audit the full resync: ${err.message}`),
      );
    this.logger.log(
      `Environmental entity resync (${reason}): re-posting ${rows.length} obstacle(s) on map ${activeMapId ?? 'none'}`,
    );
    this.changed(null);
  }

  /**
   * Repairs only the difference between WES and the kernel — never a retire-everything sweep:
   *  - a wanted, acknowledged obstacle of the loaded map that the kernel lost is re-queued;
   *  - a WES-owned entity the kernel still holds but WES no longer wants is retired on its own,
   *    except while its cargo's successor entity is still being created (make-before-break).
   * Entities WES did not create are never touched here (the admin obstacle table lists them).
   */
  private async checkDriftLocked(): Promise<void> {
    let kernelEntities: KernelEnvironmentalEntity[];
    try {
      kernelEntities = await this.listKernelEntities();
    } catch {
      return;
    }
    const activeMapId = await this.activeMap.id();
    if (!activeMapId) return;

    const byName = new Map(
      kernelEntities.map((entity) => [entity.name, entity]),
    );
    const present = (
      await this.store.findByDesiredState(EntityDesiredState.PRESENT)
    ).filter((row) => row.mapRecordId === activeMapId);

    const missing = present.filter(
      (row) =>
        row.syncStatus === EntitySyncStatus.ACKED &&
        matchEntity(byName.get(row.entityName) ?? null, row.cargoId) !==
          'ACTIVE_OWNED',
    );
    const wanted = new Set(present.map((row) => row.entityName));
    const awaitingSuccessor = new Set(
      present
        .filter((row) => row.syncStatus !== EntitySyncStatus.ACKED)
        .map((row) => row.cargoId),
    );
    const unexpected = kernelEntities.filter(
      (entity) =>
        isWesOwned(entity) &&
        !entity.retired &&
        !wanted.has(entity.name) &&
        !awaitingSuccessor.has(entity.properties[CARGO_ID_PROPERTY]),
    );
    if (missing.length === 0 && unexpected.length === 0) return;

    this.logger.warn(
      `FMS entities drifted from WES on map ${activeMapId}: ${missing.length} missing, ${unexpected.length} unexpected — repairing`,
    );
    await this.store.updateByIds(
      missing.map((row) => row.id),
      {
        syncStatus: EntitySyncStatus.PENDING,
        errorKind: null,
        lastError: 'FMS mất vật cản — tạo lại',
        attemptCount: 0,
        nextRetryAt: null,
      },
    );
    const retired: string[] = [];
    for (const entity of unexpected) {
      try {
        await this.kernelApi.retireEnvironmentalEntity(entity.name);
        retired.push(entity.name);
      } catch (err) {
        this.logger.warn(
          `Could not retire unexpected entity ${entity.name}: ${(err as Error).message}`,
        );
      }
    }
    await this.store
      .appendLog({
        cargoId: null,
        entityName: null,
        event: 'DRIFT_REPAIR',
        detail: `${missing.length} thiếu, ${unexpected.length} thừa trên FMS`,
        payload: {
          mapRecordId: activeMapId,
          requeued: missing.map((row) => row.entityName),
          retired,
        },
      })
      .catch((err: Error) =>
        this.logger.error(`Could not audit the drift repair: ${err.message}`),
      );
    this.changed(null);
  }

  private async reconcileDesiredStates(): Promise<void> {
    const deliveredWithoutRow =
      await this.store.findDeliveredCargoWithoutRow(RECONCILE_BATCH_SIZE);
    const taskIds = await this.store.findLatestTaskIds(
      deliveredWithoutRow.map((cargo) => cargo.id),
    );
    for (const cargo of deliveredWithoutRow) {
      this.logger.warn(
        `Cargo ${cargo.id} is DELIVERED without an obstacle row — queuing it`,
      );
      await this.markPresent(cargo, taskIds.get(cargo.id) ?? null);
    }

    const present = await this.store.findByDesiredState(
      EntityDesiredState.PRESENT,
    );
    const cargos = await this.store.findCargosIncludingDeleted(
      present.map((row) => row.cargoId),
    );
    const cargoById = new Map(cargos.map((cargo) => [cargo.id, cargo]));
    const retireByReason = new Map<string, string[]>();
    for (const row of present) {
      const reason = obstacleIneligibility(cargoById.get(row.cargoId) ?? null);
      if (reason) {
        retireByReason.set(reason, [
          ...(retireByReason.get(reason) ?? []),
          row.cargoId,
        ]);
      }
    }
    for (const [reason, cargoIds] of retireByReason) {
      await this.markRetiredMany(cargoIds, reason);
    }
  }

  private async listKernelEntities(): Promise<KernelEnvironmentalEntity[]> {
    return (await this.kernelApi.listEnvironmentalEntities())
      .map(toKernelEntity)
      .filter((entity): entity is KernelEnvironmentalEntity => entity !== null);
  }

  private async audit(
    row: CargoEnvironmentalEntity,
    event: EntitySyncLogEvent,
    detail: string,
    payload?: unknown,
  ): Promise<void> {
    try {
      await this.store.appendLog({
        cargoId: row.cargoId,
        entityName: row.entityName,
        event,
        detail,
        payload: payload ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Could not audit ${event} of cargo ${row.cargoId}: ${(err as Error).message}`,
      );
    }
  }

  private changed(cargoId: string | null): void {
    this.eventEmitter.emit(ENVIRONMENTAL_ENTITY_EVENTS.CHANGED, { cargoId });
  }
}

function foreignEntityError(
  name: string,
  entity: KernelEnvironmentalEntity | null,
): EntitySyncError {
  const owner = entity?.properties[CARGO_ID_PROPERTY] ?? 'không rõ';
  return new EntitySyncError(
    `Entity ${name} trên FMS thuộc hàng khác (${owner}) — không ghi đè, không retire`,
    EntitySyncErrorKind.FATAL,
  );
}

export function toSyncView(row: CargoEnvironmentalEntity): EntitySyncView {
  return {
    entityName: row.entityName,
    generation: row.generation,
    desiredState: row.desiredState,
    status: row.syncStatus,
    errorKind: row.errorKind,
    attemptCount: row.attemptCount,
    lastAttemptAt: isoOrNull(row.lastAttemptAt),
    nextRetryAt: isoOrNull(row.nextRetryAt),
    ackedAt: isoOrNull(row.ackedAt),
    lastError: row.lastError,
  };
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}
