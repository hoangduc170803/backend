import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject } from 'rxjs';
import { CargoService } from '../../cargo/cargo.service';
import type { CargoResponseDto } from '../../cargo/cargo.dto';
import { CargoStatus } from '../../cargo/entities/cargo.entity';
import { TaskStatus } from '../../cargo/entities/transport-task.entity';
import {
  ENVIRONMENTAL_ENTITY_EVENTS,
  TRANSPORT_TASK_EVENTS,
  ZONE_EVENTS,
} from '../../cargo/domain/events';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import { MapNameLookup } from '../../maps/infrastructure/map-name-lookup.service';
import {
  resolveMapFilter,
  type MapScopeQueryDto,
} from '../../maps/domain/map-scope';
import type {
  CargoDeleteResponse,
  CargoDeleteResultDto,
  CargoDto,
  CargoListDto,
  CreateCargoBody,
  MapTagDto,
  OperatingCargoStatus,
} from '../dto/operating.dto';

const PAGE_SIZE = 200;
/** Safety bound on the cargo of one map (25 pages); hitting it sets `truncated`. Cargo on a map
 *  is bounded by its slots, so this is far above anything a real floor holds. */
const MAX_PAGES = 25;
const OUT_OF_SCOPE =
  'Vai trò của bạn không được gán quyền thao tác trên bản đồ đang tải.';

/**
 * Maps wes cargo (CargoResponseDto — the full state-machine view) to the flat `Cargo` shape the
 * operating client expects, and pushes a bare SSE tick whenever a transport task changes so the
 * client re-fetches. All cargo lifecycle stays in CargoService.
 */
@Injectable()
export class OperatingCargoService {
  private readonly ticks = new Subject<void>();

  constructor(
    private readonly cargo: CargoService,
    private readonly activeMap: ActiveMapContext,
    private readonly mapNames: MapNameLookup,
  ) {}

  get changes$(): Observable<void> {
    return this.ticks.asObservable();
  }

  @OnEvent(TRANSPORT_TASK_EVENTS.CREATED)
  @OnEvent(TRANSPORT_TASK_EVENTS.STATUS_CHANGED)
  @OnEvent(TRANSPORT_TASK_EVENTS.COMPLETED)
  @OnEvent(TRANSPORT_TASK_EVENTS.FAILED)
  @OnEvent(TRANSPORT_TASK_EVENTS.UPDATED)
  @OnEvent(ENVIRONMENTAL_ENTITY_EVENTS.CHANGED)
  @OnEvent(ZONE_EVENTS.SLOT_CHANGED)
  onTaskChanged(): void {
    this.ticks.next();
  }

  /**
   * `query`: the loaded map by default, `scope=all` / `mapRecordId` for the whole database.
   * `mapIds`: the caller's AUTH-3 map scope (`undefined` = unrestricted — see `ability.ts`).
   * Cancelled cargo is filtered in SQL, so `total` always counts exactly what the list can show.
   */
  async list(
    query: MapScopeQueryDto = {},
    mapIds?: string[],
  ): Promise<CargoListDto> {
    const loadedMapId = await this.activeMap.id();
    const filter = resolveMapFilter(query, loadedMapId, mapIds);
    const { cargos, total, truncated } = await this.everyCargo(filter.ids);
    const names = await this.mapNames.namesOf(
      cargos.map((cargo) => cargo.mapRecordId),
    );
    return {
      cargos: cargos.map((cargo) =>
        toCargoDto(cargo, {
          mapRecordId: cargo.mapRecordId,
          mapName: cargo.mapRecordId
            ? (names.get(cargo.mapRecordId) ?? null)
            : null,
          onLoadedMap:
            cargo.mapRecordId !== null && cargo.mapRecordId === loadedMapId,
        }),
      ),
      total,
      truncated,
    };
  }

  /**
   * The map draws every cargo that sits on it, so the list is read to the end page by page
   * instead of stopping at the newest page — a cargo still on the floor must never drop off the
   * map because newer ones were created.
   */
  private async everyCargo(mapIds: string[] | null): Promise<{
    cargos: CargoResponseDto[];
    total: number;
    truncated: boolean;
  }> {
    const cargos: CargoResponseDto[] = [];
    let total = 0;
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.cargo.list(
        { page, limit: PAGE_SIZE },
        { mapIds, excludeCancelled: true },
      );
      cargos.push(...result.cargos);
      total = result.total;
      truncated = result.truncated;
      if (!truncated) break;
    }
    return { cargos, total, truncated };
  }

  /** True unless the caller is scoped and the currently-loaded map falls outside that scope —
   *  same check as `OperatingAreasService.mapInScope`; cargo mutations always act against
   *  whatever map the kernel currently has loaded, the same way an Area edit does. */
  private async mapInScope(mapIds: string[] | undefined): Promise<boolean> {
    if (mapIds === undefined) return true;
    const activeId = await this.activeMap.id();
    return activeId !== null && mapIds.includes(activeId);
  }

  private async assertMapInScope(mapIds: string[] | undefined): Promise<void> {
    if (!(await this.mapInScope(mapIds))) {
      throw new ForbiddenException(OUT_OF_SCOPE);
    }
  }

  async create(
    body: CreateCargoBody,
    userId: string,
    mapIds?: string[],
  ): Promise<CargoDto> {
    await this.assertMapInScope(mapIds);
    const created = await this.cargo.create(
      {
        itemCode: body.cargoId,
        sourcePointName: body.pickupPointName,
        destinationZoneId: body.targetStoreAreaWesId,
      },
      userId,
    );
    return toCargoDto(await this.cargo.findOne(created.id));
  }

  async cancel(id: string, mapIds?: string[]): Promise<CargoDto> {
    const loadedMapId = await this.loadedMapIdInScope(mapIds);
    const before = await this.removeFromLoadedMap(id, loadedMapId);
    return {
      ...toCargoDto(before),
      status: 'FAILED',
      doneAt: new Date().toISOString(),
    };
  }

  async cancelMany(
    ids: readonly string[],
    mapIds?: string[],
  ): Promise<CargoDeleteResponse> {
    const loadedMapId = await this.loadedMapIdInScope(mapIds);
    const outcomes = await this.cargo.removeManyOnMap(ids, loadedMapId);
    return {
      results: outcomes.map(
        ({ cargoId, reason }): CargoDeleteResultDto => ({
          cargoId,
          outcome: reason === null ? 'deleted' : 'failed',
          reason,
        }),
      ),
    };
  }

  private async loadedMapIdInScope(
    mapIds: string[] | undefined,
  ): Promise<string | null> {
    const loadedMapId = await this.activeMap.id();
    if (mapIds !== undefined && !(loadedMapId && mapIds.includes(loadedMapId)))
      throw new ForbiddenException(OUT_OF_SCOPE);
    return loadedMapId;
  }

  private async removeFromLoadedMap(
    id: string,
    loadedMapId: string | null,
  ): Promise<CargoResponseDto> {
    const before = await this.cargo.findOne(id);
    if (before.mapRecordId !== loadedMapId) {
      throw new NotFoundException('Không tìm thấy hàng trên bản đồ đang tải.');
    }
    await this.cargo.remove(id, loadedMapId);
    return before;
  }
}

function mapStatus(cargo: CargoResponseDto): OperatingCargoStatus {
  if (cargo.status === CargoStatus.FAILED) return 'FAILED';
  if (
    cargo.status === CargoStatus.DELIVERED ||
    cargo.taskStatus === TaskStatus.DELIVERY_COMPLETED
  ) {
    return 'DONE';
  }
  switch (cargo.taskStatus) {
    case null:
    case TaskStatus.CREATED:
    case TaskStatus.READY_TO_ASSIGN:
      return 'QUEUED';
    case TaskStatus.BLOCKED:
      return 'BLOCKED';
    case TaskStatus.PICKING_UP:
      return cargo.assignedVehicleName ? 'PICKING' : 'PICK_PENDING';
    case TaskStatus.DELIVERING:
      return cargo.visual.state === 'AT_DESTINATION' ? 'SHIPPING' : 'CARRYING';
    case TaskStatus.FAILED:
      return 'FAILED';
    default:
      return 'QUEUED';
  }
}

/** Single-cargo responses (create / cancel) always concern the loaded map. */
function toCargoDto(
  cargo: CargoResponseDto,
  tag: MapTagDto = {
    mapRecordId: cargo.mapRecordId,
    mapName: null,
    onLoadedMap: true,
  },
): CargoDto {
  const done =
    cargo.status === CargoStatus.DELIVERED ||
    cargo.taskStatus === TaskStatus.DELIVERY_COMPLETED;
  return {
    cargoId: cargo.id,
    itemCode: cargo.itemCode,
    status: mapStatus(cargo),
    processingVehicle: cargo.assignedVehicleName,
    pickupAreaWesId: cargo.sourceZoneId,
    pickupPointName: cargo.sourcePointName,
    pickupLocationName: cargo.sourcePickupLocationName,
    targetStoreAreaWesId: cargo.destinationZoneId,
    dropPointName:
      cargo.visual.state === 'AT_DESTINATION' ? cargo.visual.pointName : null,
    dropLocationName: cargo.destinationLocationName,
    reservedLocationName: cargo.reservedLocationName,
    destinationLocationName: cargo.destinationLocationName,
    slotDecisionSeq: cargo.slotDecisionSeq,
    failureReason: cargo.blockedReason,
    createdAt: cargo.createdAt.toISOString(),
    updatedAt: cargo.updatedAt.toISOString(),
    doneAt: done ? cargo.updatedAt.toISOString() : null,
    entitySync: cargo.entitySync,
    ...tag,
  };
}
