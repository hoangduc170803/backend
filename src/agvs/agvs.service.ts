import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, IsNull, QueryFailedError, Repository } from 'typeorm';
import { AgvEntity } from './entities/agv.entity';
import { ActiveMapRecordService } from '../maps/infrastructure/active-map-record.service';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import type {
  AgvAcceptanceAction,
  AgvAcceptanceResponse,
  AgvAcceptanceResultDto,
  AgvBulkResponse,
  AgvDto,
  AgvListResponse,
  CreateAgvDto,
  ListAgvsQueryDto,
  SetAgvAcceptanceDto,
  UpdateAgvBatteryThresholdsDto,
  UpdateAgvDto,
} from './dto/agvs.dto';
import { resolveKernelStatus, toAgvDto } from './agvs.mapper';
import {
  batteryThresholdError,
  thresholdsOf,
  type BatteryThresholdColumns,
} from './domain/battery-thresholds';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

const IGNORED_USE_RESTORE = 'AGV đang bị bỏ qua — hãy dùng Khôi phục.';

function acceptanceBlocker(
  agv: AgvEntity,
  action: AgvAcceptanceAction,
): string | null {
  switch (action) {
    case 'enable':
      if (agv.isIgnored) return IGNORED_USE_RESTORE;
      return agv.isDispatchEnabled ? 'AGV đã ở trạng thái nhận việc.' : null;
    case 'disable':
      if (agv.isIgnored) return IGNORED_USE_RESTORE;
      return agv.isDispatchEnabled ? null : 'AGV đã ngừng nhận việc.';
    case 'ignore':
      return agv.isIgnored ? 'AGV đã bị bỏ qua.' : null;
    case 'restore':
      return agv.isIgnored ? null : 'AGV không ở trạng thái bỏ qua.';
  }
}

function isNoOp(agv: AgvEntity, action: AgvAcceptanceAction): boolean {
  switch (action) {
    case 'enable':
    case 'restore':
      return !agv.isIgnored && agv.isDispatchEnabled;
    case 'disable':
      return !agv.isIgnored && !agv.isDispatchEnabled;
    case 'ignore':
      return agv.isIgnored;
  }
}

const AGV_NOT_FOUND = 'AGV không tồn tại.';

@Injectable()
export class AgvsService {
  constructor(
    @InjectRepository(AgvEntity)
    private readonly repo: Repository<AgvEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly vehicleStateStore: VehicleStateStore,
    private readonly activeMapRecords: ActiveMapRecordService,
  ) {}

  /**
   * Lists every registered AGV across every map — this is the admin registry view, deliberately
   * unscoped. The Operating screen narrows to the currently loaded map itself, client-side (see
   * `useVehicleRegistry` in wes-new-client-v2), from this same unfiltered list.
   */
  async list(query: ListAgvsQueryDto = {}): Promise<AgvListResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const search = query.search?.trim();

    const where = search
      ? [{ code: ILike(`%${search}%`) }, { name: ILike(`%${search}%`) }]
      : undefined;

    const [agvs, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const kernelReachable = this.vehicleStateStore.isConnected();
    const kernelByName = new Map<string, KernelVehicleState>(
      this.vehicleStateStore.getAll().map((v) => [v.name, v]),
    );
    const loadedMapId = await this.loadedMapId();

    return {
      agvs: agvs.map((agv) =>
        toAgvDto(
          agv,
          resolveKernelStatus(
            kernelReachable,
            kernelByName.get(agv.name),
            isOnLoadedMap(agv, loadedMapId),
          ),
        ),
      ),
      total,
      page,
      limit,
      kernelReachable,
    };
  }

  private async toDto(agv: AgvEntity): Promise<AgvDto> {
    const kernelReachable = this.vehicleStateStore.isConnected();
    const vehicle = this.vehicleStateStore.get(agv.name);
    return toAgvDto(
      agv,
      resolveKernelStatus(
        kernelReachable,
        vehicle,
        isOnLoadedMap(agv, await this.loadedMapId()),
      ),
    );
  }

  private loadedMapId(): Promise<string | null> {
    return this.activeMapRecords.resolveId().catch(() => null);
  }

  async findOne(id: string): Promise<AgvDto> {
    const agv = await this.repo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException('AGV không tồn tại.');
    return this.toDto(agv);
  }

  private findCodeConflict(
    code: string,
    mapRecordId: string | null,
  ): Promise<AgvEntity | null> {
    return this.repo.findOne({
      where: { code, mapRecordId: mapRecordId ?? IsNull() },
    });
  }

  private async saveUnique(agv: AgvEntity): Promise<AgvEntity> {
    try {
      return await this.repo.save(agv);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `AGV "${agv.name}" (code "${agv.code}") đã tồn tại trong bản đồ này.`,
        );
      }
      throw err;
    }
  }

  private findNameConflict(
    name: string,
    mapRecordId: string | null,
  ): Promise<AgvEntity | null> {
    return this.repo.findOne({
      where: { name, mapRecordId: mapRecordId ?? IsNull() },
    });
  }

  private findInitialPositionConflict(
    initialPosition: string,
    mapRecordId: string | null,
  ): Promise<AgvEntity | null> {
    return this.repo.findOne({
      where: {
        initialPosition,
        mapRecordId: mapRecordId ?? IsNull(),
      },
    });
  }

  private async sameVehicleThresholds(
    name: string,
  ): Promise<Partial<BatteryThresholdColumns>> {
    const sibling = await this.repo.findOne({ where: { name } });
    return sibling ? thresholdColumns(sibling) : {};
  }

  private async syncThresholdsAcrossMaps(agv: AgvEntity): Promise<void> {
    await this.repo.update({ name: agv.name }, thresholdColumns(agv));
  }

  async create(dto: CreateAgvDto, userId: string): Promise<AgvDto> {
    const currentMapName = await this.kernelApi.getPlantModelName();
    const mapRecordId = await this.activeMapRecords.resolveId();
    const initialPosition = dto.initialPosition?.trim() || null;

    if (await this.findCodeConflict(dto.code, mapRecordId)) {
      throw new ConflictException(`Code "${dto.code}" đã tồn tại.`);
    }

    if (currentMapName) {
      const kernelVehicles = await this.kernelApi.getVehicleStates();
      const existsInKernel = kernelVehicles.some((v) => v.name === dto.name);
      if (!existsInKernel) {
        throw new BadRequestException(
          `Xe "${dto.name}" không tồn tại trong bản đồ "${currentMapName}" đang tải trên hệ thống điều khiển.`,
        );
      }
    }

    if (await this.findNameConflict(dto.name, mapRecordId)) {
      throw new ConflictException(`AGV tên "${dto.name}" đã tồn tại.`);
    }

    if (
      initialPosition &&
      (await this.findInitialPositionConflict(initialPosition, mapRecordId))
    ) {
      throw new ConflictException(
        `Initial position "${initialPosition}" is already assigned to another AGV in this map.`,
      );
    }

    const thresholds = resolveThresholds(
      await this.sameVehicleThresholds(dto.name),
      dto,
    );
    const agv = this.repo.create({
      code: dto.code,
      name: dto.name,
      model: dto.model ?? null,
      manufacturer: dto.manufacturer ?? null,
      serialNumber: dto.serialNumber ?? null,
      isDispatchEnabled: dto.isDispatchEnabled ?? true,
      ...thresholds,
      initialPosition,
      config: dto.config ?? {},
      plantModelName: currentMapName,
      mapRecordId,
      createdById: userId,
    });
    const saved = await this.saveUnique(agv);
    await this.syncThresholdsAcrossMaps(saved);
    return toAgvDto(saved, 'unknown');
  }

  async update(id: string, dto: UpdateAgvDto): Promise<AgvDto> {
    const agv = await this.repo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException('AGV không tồn tại.');

    if (dto.name && dto.name !== agv.name) {
      const existing = await this.findNameConflict(dto.name, agv.mapRecordId);
      if (existing && existing.id !== id) {
        throw new ConflictException(`AGV tên "${dto.name}" đã tồn tại.`);
      }
    }

    const nextInitialPosition =
      dto.initialPosition !== undefined
        ? dto.initialPosition.trim() || null
        : agv.initialPosition;
    if (nextInitialPosition && nextInitialPosition !== agv.initialPosition) {
      const existing = await this.findInitialPositionConflict(
        nextInitialPosition,
        agv.mapRecordId,
      );
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `Initial position "${nextInitialPosition}" is already assigned to another AGV in this map.`,
        );
      }
    }

    Object.assign(agv, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.model !== undefined && { model: dto.model }),
      ...(dto.manufacturer !== undefined && { manufacturer: dto.manufacturer }),
      ...(dto.serialNumber !== undefined && { serialNumber: dto.serialNumber }),
      ...(dto.initialPosition !== undefined && {
        initialPosition: nextInitialPosition,
      }),
      ...(dto.config !== undefined && { config: dto.config }),
    });

    const saved = await this.saveUnique(agv);
    return toAgvDto(saved, 'unknown');
  }

  async updateBatteryThresholds(
    id: string,
    dto: UpdateAgvBatteryThresholdsDto,
  ): Promise<AgvDto> {
    const agv = await this.repo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException('AGV không tồn tại.');

    Object.assign(agv, resolveThresholds(thresholdColumns(agv), dto));
    const saved = await this.saveUnique(agv);
    await this.syncThresholdsAcrossMaps(saved);
    return toAgvDto(saved, 'unknown');
  }

  async connect(id: string): Promise<void> {
    const agv = await this.repo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException(AGV_NOT_FOUND);
    await this.connectVehicle(agv.name);
  }

  async disconnect(id: string): Promise<void> {
    const agv = await this.repo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException(AGV_NOT_FOUND);
    await this.disconnectVehicle(agv.name);
  }

  private async connectVehicle(name: string): Promise<void> {
    await this.kernelApi.setVehicleAdapterEnabled(name, true);
    await this.kernelApi.setVehicleIntegrationLevel(name, 'TO_BE_UTILIZED');
  }

  private async disconnectVehicle(name: string): Promise<void> {
    await this.kernelApi.setVehicleIntegrationLevel(name, 'TO_BE_IGNORED');
    await this.kernelApi.setVehicleAdapterEnabled(name, false);
  }

  enable(id: string): Promise<AgvDto> {
    return this.runAcceptance(id, 'enable');
  }

  disable(id: string): Promise<AgvDto> {
    return this.runAcceptance(id, 'disable');
  }

  ignore(id: string): Promise<AgvDto> {
    return this.runAcceptance(id, 'ignore');
  }

  restore(id: string): Promise<AgvDto> {
    return this.runAcceptance(id, 'restore');
  }

  async setAcceptance(
    dto: SetAgvAcceptanceDto,
  ): Promise<AgvAcceptanceResponse> {
    const ids = [...new Set(dto.ids)];
    const agvs = ids.length
      ? await this.repo.find({ where: { id: In(ids) } })
      : [];
    const agvById = new Map(agvs.map((agv) => [agv.id, agv]));
    const results: AgvAcceptanceResultDto[] = [];
    for (const id of ids) {
      results.push({
        id,
        ...(await this.tryAcceptance(agvById.get(id) ?? null, dto.action)),
      });
    }
    return { action: dto.action, results };
  }

  private async runAcceptance(
    id: string,
    action: AgvAcceptanceAction,
  ): Promise<AgvDto> {
    const agv = await this.repo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException('AGV không tồn tại.');
    const blocker = acceptanceBlocker(agv, action);
    if (blocker) throw new ConflictException(blocker);
    return this.toDto(await this.applyAcceptance(agv, action));
  }

  private async tryAcceptance(
    agv: AgvEntity | null,
    action: AgvAcceptanceAction,
  ): Promise<Omit<AgvAcceptanceResultDto, 'id'>> {
    if (!agv) return { outcome: 'failed', reason: 'AGV không tồn tại.' };

    const blocker = acceptanceBlocker(agv, action);
    if (blocker) {
      return {
        outcome: isNoOp(agv, action) ? 'unchanged' : 'failed',
        reason: blocker,
      };
    }

    try {
      await this.applyAcceptance(agv, action);
      return { outcome: 'changed', reason: null };
    } catch (err) {
      return { outcome: 'failed', reason: (err as Error).message };
    }
  }

  private async applyAcceptance(
    agv: AgvEntity,
    action: AgvAcceptanceAction,
  ): Promise<AgvEntity> {
    if (action === 'ignore' || action === 'restore') {
      await this.kernelApi.setVehicleIntegrationLevel(
        agv.name,
        action === 'ignore' ? 'TO_BE_RESPECTED' : 'TO_BE_UTILIZED',
      );
    }
    if (action === 'enable') agv.isDispatchEnabled = true;
    if (action === 'disable') agv.isDispatchEnabled = false;
    if (action === 'ignore') agv.isIgnored = true;
    if (action === 'restore') {
      agv.isIgnored = false;
      agv.isDispatchEnabled = true;
    }
    return this.repo.save(agv);
  }

  async remove(id: string): Promise<void> {
    const agv = await this.repo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException(AGV_NOT_FOUND);
    await this.repo.remove(agv);
  }

  async removeMany(ids: readonly string[]): Promise<AgvBulkResponse> {
    const agvById = await this.findByIds(ids);
    if (agvById.size > 0) {
      await this.repo.delete({ id: In([...agvById.keys()]) });
    }
    return {
      results: uniqueIds(ids).map((id) =>
        agvById.has(id)
          ? { id, outcome: 'changed', reason: null }
          : { id, outcome: 'failed', reason: AGV_NOT_FOUND },
      ),
    };
  }

  async setConnectionMany(
    ids: readonly string[],
    connected: boolean,
  ): Promise<AgvBulkResponse> {
    const agvById = await this.findByIds(ids);
    const results: AgvAcceptanceResultDto[] = [];
    for (const id of uniqueIds(ids)) {
      const agv = agvById.get(id);
      if (!agv) {
        results.push({ id, outcome: 'failed', reason: AGV_NOT_FOUND });
        continue;
      }
      try {
        await (connected
          ? this.connectVehicle(agv.name)
          : this.disconnectVehicle(agv.name));
        results.push({ id, outcome: 'changed', reason: null });
      } catch (err) {
        results.push({ id, outcome: 'failed', reason: (err as Error).message });
      }
    }
    return { results };
  }

  private async findByIds(
    ids: readonly string[],
  ): Promise<Map<string, AgvEntity>> {
    const unique = uniqueIds(ids);
    if (unique.length === 0) return new Map();
    const agvs = await this.repo.find({ where: { id: In(unique) } });
    return new Map(agvs.map((agv) => [agv.id, agv]));
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string } | undefined)?.code === '23505'
  );
}

/** Legacy AGVs without a map still match the kernel by name, as before map scoping. */
function isOnLoadedMap(agv: AgvEntity, loadedMapId: string | null): boolean {
  return agv.mapRecordId === null || agv.mapRecordId === loadedMapId;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function thresholdColumns(
  source: BatteryThresholdColumns,
): BatteryThresholdColumns {
  return {
    criticalBatteryThreshold: source.criticalBatteryThreshold,
    goodBatteryThreshold: source.goodBatteryThreshold,
    sufficientBatteryThreshold: source.sufficientBatteryThreshold,
    fullBatteryThreshold: source.fullBatteryThreshold,
  };
}

function resolveThresholds(
  current: Partial<BatteryThresholdColumns>,
  requested: Partial<BatteryThresholdColumns>,
): BatteryThresholdColumns {
  const merged = thresholdsOf({
    criticalBatteryThreshold:
      requested.criticalBatteryThreshold ?? current.criticalBatteryThreshold,
    goodBatteryThreshold:
      requested.goodBatteryThreshold ?? current.goodBatteryThreshold,
    sufficientBatteryThreshold:
      requested.sufficientBatteryThreshold ??
      current.sufficientBatteryThreshold,
    fullBatteryThreshold:
      requested.fullBatteryThreshold ?? current.fullBatteryThreshold,
  });
  const error = batteryThresholdError(merged);
  if (error) throw new BadRequestException(error);
  return {
    criticalBatteryThreshold: merged.critical,
    goodBatteryThreshold: merged.good,
    sufficientBatteryThreshold: merged.sufficient,
    fullBatteryThreshold: merged.full,
  };
}
