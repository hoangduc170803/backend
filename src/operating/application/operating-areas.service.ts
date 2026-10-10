import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, type SelectQueryBuilder } from 'typeorm';
import { Observable, Subject } from 'rxjs';
import { OnEvent } from '@nestjs/event-emitter';
import { ZoneService } from '../../zones/zone.service';
import { ZoneStatus, ZoneType } from '../../zones/entities/zone.entity';
import {
  LOCATION_PREFIX,
  pointNameOf,
} from '../../zones/domain/location-naming';
import type { ZoneListItemResponse } from '../../zones/zone.dto';
import { CargoEntity, CargoStatus } from '../../cargo/entities/cargo.entity';
import { CargoService } from '../../cargo/cargo.service';
import {
  TaskStatus,
  TransportTaskEntity,
} from '../../cargo/entities/transport-task.entity';
import { TRANSPORT_TASK_EVENTS } from '../../cargo/domain/events';
import {
  isStillAtSource,
  latestTaskStatusByCargoId,
} from '../../cargo/task-queries';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { MapNameLookup } from '../../maps/infrastructure/map-name-lookup.service';
import {
  resolveMapFilter,
  type MapScopeQueryDto,
} from '../../maps/domain/map-scope';
import type {
  AreaDto,
  AreaKind,
  AreaMemberState,
  AreaCargoPurgeResult,
  CopyAreasFromMapBody,
  CopyAreasFromMapResult,
  CreateAreaBody,
  ReplaceAreaMembersBody,
  UpdateAreaBody,
} from '../dto/operating.dto';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * A cargo is still in progress only while it is ACTIVE **and** its latest task has not ended in
 * failure. A cargo whose task FAILED or was CANCELLED is over even when its own row still says
 * ACTIVE — the operator sees it as "Lỗi" — so it must not hold an area back.
 */
const LATEST_TASK_STATUS = `(SELECT task.status::text FROM transport_requests task WHERE task.cargo_id = cargo.id ORDER BY task.created_at DESC, task.id DESC LIMIT 1)`;
const CARGO_IN_PROGRESS = `(cargo.status = '${CargoStatus.ACTIVE}' AND COALESCE(${LATEST_TASK_STATUS}, '') NOT IN ('${TaskStatus.FAILED}', '${TaskStatus.CANCELLED}'))`;
const CARGO_LEFT_ITS_PICKUP_SLOT = `(COALESCE(${LATEST_TASK_STATUS}, '') IN ('${TaskStatus.DELIVERING}', '${TaskStatus.DELIVERY_COMPLETED}', '${TaskStatus.COMPLETED}'))`;
/**
 * A cargo holds the area whose slot it occupies or is headed to: its pickup area until a vehicle
 * has taken it away, its drop area while it is on the way and for as long as it stands there
 * delivered. Cargo an area has already shipped out must not keep that area from being edited.
 */
const CARGO_HOLDS_AREA = `((cargo.source_zone_id = :zoneId AND ${CARGO_IN_PROGRESS} AND NOT ${CARGO_LEFT_ITS_PICKUP_SLOT}) OR (cargo.destination_zone_id = :zoneId AND (cargo.status = '${CargoStatus.DELIVERED}' OR ${CARGO_IN_PROGRESS})))`;
const CARGO_FINISHED = `(cargo.status IN ('${CargoStatus.DELIVERED}', '${CargoStatus.FAILED}') OR (cargo.status = '${CargoStatus.ACTIVE}' AND NOT ${CARGO_IN_PROGRESS}))`;

interface SlotState {
  state: AreaMemberState;
  cargoId: string;
}

/**
 * Presents wes Zones to the operating client as "Areas" (the shape the retired wes-new backend
 * used). All zone/store logic — kernel Location writes, reachability, sync, kernelId — stays in
 * ZoneService; this only translates field names and derives per-slot occupancy from cargo.
 *
 * Editing (`replaceMembers`) and deleting are refused with 409 while the area still has cargo in
 * flight — wes has no in-place member edit, so an edit is delete + recreate (report §5.9 / §7.2).
 */
@Injectable()
export class OperatingAreasService {
  private readonly ticks = new Subject<void>();

  constructor(
    private readonly zones: ZoneService,
    private readonly kernelApi: KernelApiService,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly mapNames: MapNameLookup,
    private readonly cargo: CargoService,
  ) {}

  /** Bare SSE tick whenever an area / its kernel Locations change — so every other open
   *  client refetches instead of showing a stale zone list until an F5 or a tab refocus. */
  get changes$(): Observable<void> {
    return this.ticks.asObservable();
  }

  @OnEvent(TRANSPORT_TASK_EVENTS.CREATED)
  @OnEvent(TRANSPORT_TASK_EVENTS.STATUS_CHANGED)
  @OnEvent(TRANSPORT_TASK_EVENTS.COMPLETED)
  @OnEvent(TRANSPORT_TASK_EVENTS.FAILED)
  @OnEvent(TRANSPORT_TASK_EVENTS.UPDATED)
  onCargoChanged(): void {
    this.ticks.next();
  }

  /** `mapIds`: the caller's AUTH-3 map scope (`undefined` = unrestricted — see `ability.ts`). */
  async list(
    mapIds?: string[],
    query: MapScopeQueryDto = {},
  ): Promise<AreaDto[]> {
    const loadedMapId = await this.zones.activeMapRecordId();
    const widened = !!query.mapRecordId || query.scope === 'all';
    let zones: ZoneListItemResponse[];
    if (widened) {
      const filter = resolveMapFilter(query, loadedMapId, mapIds);
      if (filter.ids !== null && filter.ids.length === 0) return [];
      zones = await this.zones.list({
        allMaps: true,
        mapIds: filter.ids ?? undefined,
      });
    } else {
      if (!(await this.mapInScope(mapIds))) return [];
      zones = await this.zones.list({ allMaps: false, mapIds });
    }
    if (zones.length === 0) return [];

    const slotStateByMap = new Map<string | null, Map<string, SlotState>>();
    for (const mapRecordId of new Set(zones.map((zone) => zone.mapRecordId))) {
      slotStateByMap.set(
        mapRecordId,
        await this.slotStateByLocation(
          zones
            .filter((zone) => zone.mapRecordId === mapRecordId)
            .flatMap((zone) =>
              zone.members.map((member) => member.locationName),
            ),
          mapRecordId,
        ),
      );
    }
    const names = await this.mapNames.namesOf(
      zones.map((zone) => zone.mapRecordId),
    );
    return zones.map((zone) => ({
      ...this.toArea(
        zone,
        slotStateByMap.get(zone.mapRecordId) ?? new Map<string, SlotState>(),
      ),
      mapRecordId: zone.mapRecordId,
      mapName: zone.mapRecordId ? (names.get(zone.mapRecordId) ?? null) : null,
      onLoadedMap:
        zone.mapRecordId !== null && zone.mapRecordId === loadedMapId,
    }));
  }

  async create(body: CreateAreaBody, mapIds?: string[]): Promise<AreaDto> {
    await this.assertMapInScope(mapIds);
    const zone = await this.zones.create(
      {
        name: body.name,
        type: body.kind === 'STORE' ? ZoneType.DROPOFF : ZoneType.PICKUP,
        color: HEX6.test(body.color ?? '') ? body.color : undefined,
        operation: body.operation?.trim() || undefined,
        maxVehicles: body.maxVehicles ?? undefined,
        members: this.toZoneMembers(body.members),
      },
      mapIds,
    );
    const area = await this.oneArea(zone.id, mapIds);
    this.ticks.next();
    return area;
  }

  /** Recreate another map's Zones/Stores on the loaded map — delegates to ZoneService.copyFromMap(). */
  async copyFromMap(
    body: CopyAreasFromMapBody,
    mapIds?: string[],
  ): Promise<CopyAreasFromMapResult> {
    await this.assertMapInScope(mapIds);
    const result = await this.zones.copyFromMap(
      body.sourceMapRecordId,
      body.areaIds,
      mapIds,
    );
    if (result.copied.length > 0) this.ticks.next();
    return {
      plantModelName: result.plantModelName,
      copied: result.copied.map(({ sourceId, zoneId, name }) => ({
        sourceId,
        wesId: zoneId,
        name,
      })),
      skipped: result.skipped,
      kernelWriteFailed: result.kernelWriteFailed,
    };
  }

  async update(
    id: string,
    body: UpdateAreaBody,
    mapIds?: string[],
  ): Promise<AreaDto> {
    await this.assertMapInScope(mapIds);
    await this.oneArea(id, mapIds);
    const trimmedName = body.name?.trim();
    const trimmedOperation = body.operation?.trim();
    const hasUpdate =
      (body.color && HEX6.test(body.color)) ||
      trimmedName ||
      trimmedOperation ||
      body.maxVehicles !== undefined;
    if (hasUpdate) {
      await this.zones.update(
        id,
        {
          ...(body.color && HEX6.test(body.color) ? { color: body.color } : {}),
          ...(trimmedName ? { name: trimmedName } : {}),
          ...(trimmedOperation ? { operation: trimmedOperation } : {}),
          ...(body.maxVehicles !== undefined
            ? { maxVehicles: body.maxVehicles }
            : {}),
        },
        mapIds,
      );
    }
    const area = await this.oneArea(id, mapIds);
    this.ticks.next();
    return area;
  }

  async replaceMembers(
    id: string,
    body: ReplaceAreaMembersBody,
    mapIds?: string[],
  ): Promise<AreaDto> {
    await this.assertMapInScope(mapIds);
    const existing = await this.oneArea(id, mapIds);
    await this.assertNoActiveCargo(id, 'sửa');

    await this.zones.remove(id, mapIds);
    const zone = await this.zones.create(
      {
        name: body.name?.trim() || existing.name,
        type: existing.kind === 'STORE' ? ZoneType.DROPOFF : ZoneType.PICKUP,
        color:
          existing.color && HEX6.test(existing.color)
            ? existing.color
            : undefined,
        members: this.toZoneMembers(body.members),
      },
      mapIds,
    );
    const area = await this.oneArea(zone.id, mapIds);
    this.ticks.next();
    return area;
  }

  async remove(id: string, mapIds?: string[]): Promise<void> {
    await this.assertMapInScope(mapIds);
    await this.oneArea(id, mapIds);
    await this.assertNoActiveCargo(id, 'xoá');
    await this.zones.remove(id, mapIds);
    this.ticks.next();
  }

  /**
   * Deletes every cargo of the area, allowed only once none of them is still in progress: a
   * cargo that is queued, being picked up or being delivered blocks the whole purge with 409.
   * Failed cargo counts as finished and is deleted with the delivered ones.
   */
  async purgeFinishedCargo(
    id: string,
    mapIds?: string[],
  ): Promise<AreaCargoPurgeResult> {
    await this.assertMapInScope(mapIds);
    await this.oneArea(id, mapIds);
    const unfinished = await this.cargoOfArea(id)
      .andWhere(CARGO_IN_PROGRESS)
      .getCount();
    if (unfinished > 0) {
      throw new ConflictException(
        `Còn ${unfinished} hàng chưa hoàn thành trong khu vực này — không xoá được. Hãy chờ hàng hoàn thành hoặc huỷ từng hàng trước.`,
      );
    }
    const finished = await this.cargoOfArea(id)
      .andWhere(CARGO_FINISHED)
      .select('cargo.id')
      .getMany();
    const outcomes = await this.cargo.removeManyOnMap(
      finished.map((cargo) => cargo.id),
      await this.zones.activeMapRecordId(),
    );
    this.ticks.next();
    const failed = outcomes.filter((outcome) => outcome.reason !== null);
    return {
      deleted: outcomes.length - failed.length,
      failed: failed.map(({ cargoId, reason }) => ({
        cargoId,
        reason: reason as string,
      })),
    };
  }

  /**
   * Reconcile every Zone/Store of the loaded map with the kernel: rebuild missing member
   * Locations and PUT the updated plant model. Delegates to ZoneService.sync().
   */
  async sync(mapIds?: string[]) {
    await this.assertMapInScope(mapIds);
    const result = await this.zones.sync(mapIds);
    this.ticks.next();
    return result;
  }

  /** True unless the caller is scoped and the currently-loaded map falls outside that scope. */
  private async mapInScope(mapIds: string[] | undefined): Promise<boolean> {
    if (mapIds === undefined) return true;
    const activeId = await this.zones.activeMapRecordId();
    return activeId !== null && mapIds.includes(activeId);
  }

  private async assertMapInScope(mapIds: string[] | undefined): Promise<void> {
    if (!(await this.mapInScope(mapIds))) {
      throw new ForbiddenException(
        'Vai trò của bạn không được gán quyền thao tác trên bản đồ đang tải.',
      );
    }
  }

  private toZoneMembers(
    members: { pointName: string; priority?: number }[],
  ): { locationName: string; positionIndex: number }[] {
    return members
      .map((member, index) => ({
        pointName: member.pointName,
        priority: member.priority ?? index,
      }))
      .sort((a, b) => a.priority - b.priority)
      .map((member, index) => ({
        locationName: `${LOCATION_PREFIX}${member.pointName}`,
        positionIndex: index,
      }));
  }

  private async oneArea(id: string, mapIds?: string[]): Promise<AreaDto> {
    const area = (await this.list(mapIds)).find(
      (candidate) => candidate.wesId === id,
    );
    if (!area)
      throw new NotFoundException(
        'Khu vực không tồn tại hoặc không thuộc bản đồ đang tải.',
      );
    return area;
  }

  private async assertNoActiveCargo(
    zoneId: string,
    verb: string,
  ): Promise<void> {
    const inFlight = await this.cargoOfArea(zoneId)
      .andWhere(CARGO_HOLDS_AREA)
      .getCount();
    if (inFlight > 0) {
      throw new ConflictException(
        `Còn hàng đang xử lý trong khu vực này — không thể ${verb} location. Hãy chờ hoàn tất hoặc huỷ hàng.`,
      );
    }
  }

  private cargoOfArea(zoneId: string): SelectQueryBuilder<CargoEntity> {
    return this.cargoRepo
      .createQueryBuilder('cargo')
      .where(
        '(cargo.source_zone_id = :zoneId OR cargo.destination_zone_id = :zoneId)',
        { zoneId },
      );
  }

  /**
   * Per-slot occupancy of ONE map. Location names repeat across maps (copied areas share them),
   * so cargo of another map must never mark this map's slot as taken; a zone without a map
   * only matches cargo without one.
   */
  private async slotStateByLocation(
    locationNames: string[],
    mapRecordId: string | null,
  ): Promise<Map<string, SlotState>> {
    const out = new Map<string, SlotState>();
    const locations = [...new Set(locationNames)];
    if (locations.length === 0) return out;

    const onMap = { mapRecordId: mapRecordId ?? IsNull() };
    const cargos = await this.cargoRepo.find({
      where: [
        {
          ...onMap,
          destinationLocationName: In(locations),
          status: In([CargoStatus.ACTIVE, CargoStatus.DELIVERED]),
        },
        {
          ...onMap,
          reservedLocationName: In(locations),
          status: CargoStatus.ACTIVE,
        },
        {
          ...onMap,
          sourcePickupLocationName: In(locations),
          status: CargoStatus.ACTIVE,
        },
      ],
    });

    for (const cargo of cargos) {
      const committed = cargo.destinationLocationName;
      if (committed && locations.includes(committed)) {
        out.set(committed, { state: 'OCCUPIED', cargoId: cargo.id });
      }
    }

    const pickupCandidates = cargos.filter(
      (cargo) =>
        cargo.sourcePickupLocationName &&
        locations.includes(cargo.sourcePickupLocationName) &&
        !out.has(cargo.sourcePickupLocationName),
    );
    if (pickupCandidates.length > 0) {
      const latestStatusByCargoId = await latestTaskStatusByCargoId(
        this.taskRepo,
        pickupCandidates.map((cargo) => cargo.id),
      );
      for (const cargo of pickupCandidates) {
        if (isStillAtSource(latestStatusByCargoId.get(cargo.id))) {
          out.set(cargo.sourcePickupLocationName as string, {
            state: 'OCCUPIED',
            cargoId: cargo.id,
          });
        }
      }
    }

    for (const cargo of cargos) {
      const reserved = cargo.reservedLocationName;
      if (reserved && locations.includes(reserved) && !out.has(reserved)) {
        out.set(reserved, { state: 'RESERVED', cargoId: cargo.id });
      }
    }
    return out;
  }

  private toArea(
    zone: ZoneListItemResponse,
    slotState: Map<string, SlotState>,
  ): AreaDto {
    const kind: AreaKind = zone.type === ZoneType.DROPOFF ? 'STORE' : 'ZONE';
    return {
      wesId: zone.id,
      name: zone.name,
      kind,
      operation:
        zone.operation ??
        (kind === 'STORE'
          ? this.kernelApi.unloadOperation
          : this.kernelApi.loadOperation),
      maxVehicles: zone.maxVehicles,
      color: zone.color,
      plantModelName: zone.plantModelName,
      status: zone.status === ZoneStatus.STALE ? 'STALE' : 'ACTIVE',
      members: zone.members.map((member) => {
        const slot = slotState.get(member.locationName);
        return {
          wesId: member.locationName,
          areaId: zone.id,
          opentcsLocationName: member.locationName,
          opentcsPointName: pointNameOf(member.locationName),
          priority: member.positionIndex,
          state: slot?.state ?? 'FREE',
          cargoId: slot?.cargoId ?? null,
        };
      }),
    };
  }
}
