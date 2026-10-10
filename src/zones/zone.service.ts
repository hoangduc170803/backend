import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, QueryFailedError, Repository } from 'typeorm';
import { ZoneEntity, ZoneStatus, ZoneType } from './entities/zone.entity';
import { ZoneMemberEntity } from './entities/zone-member.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import {
  readPlantTopology,
  type PlantTopology,
} from '../opentcs/plant-model-locations';
import { ZoneLocationWriter } from './zone-location.writer';
import { ZoneUsageQuery } from './zone-usage.query';
import { ActiveMapRecordService } from '../maps/infrastructure/active-map-record.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  toZoneResponse,
  type CreateZoneDto,
  type UpdateZoneDto,
  type ZoneListItemResponse,
  type ZoneResponse,
} from './zone.dto';
import {
  reviewDropoffLayout,
  type LayoutProblem,
} from './domain/zone-layout.rules';
import { pointNameOf } from './domain/location-naming';
import {
  planZoneSync,
  withRebuildsFailed,
  type SyncCandidate,
  type SyncStatus,
} from './domain/zone-sync.policy';
import { ZONE_COLOR_PALETTE, pickLeastUsedColor } from './domain/zone-color';
import { planZoneCopy, type CopySkip } from './domain/zone-copy.plan';

export interface SyncResult {
  plantModelName: string | null;
  total: number;
  markedStale: number;
  markedActive: number;
  skippedOtherMaps: number;
  unassigned: number;
  kernelUnreachable: boolean;
}

export interface CopyFromMapResult {
  plantModelName: string;
  copied: { sourceId: string; zoneId: string; name: string }[];
  skipped: CopySkip[];
  /** True when the copies were saved but their kernel Locations could not be written — they
   *  are STALE until a sync repairs them. */
  kernelWriteFailed: boolean;
}

export interface AssignMapResult {
  plantModelName: string;
  assigned: number;
}

@Injectable()
export class ZoneService {
  private readonly logger = new Logger(ZoneService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    @InjectRepository(ZoneMemberEntity)
    private readonly memberRepo: Repository<ZoneMemberEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly locationWriter: ZoneLocationWriter,
    private readonly usage: ZoneUsageQuery,
    private readonly activeMapRecords: ActiveMapRecordService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  /** The currently-loaded map's record id, or null if unresolved — for AUTH-3 scope checks. */
  activeMapRecordId(): Promise<string | null> {
    return this.activeMap.id();
  }

  private assertRecordScope(
    mapRecordId: string | null,
    mapIds?: string[],
  ): void {
    if (
      mapIds !== undefined &&
      (!mapRecordId || !mapIds.includes(mapRecordId))
    ) {
      throw new ForbiddenException(
        'Khu vực nằm ngoài phạm vi bản đồ được phép.',
      );
    }
  }

  async create(dto: CreateZoneDto, mapIds?: string[]): Promise<ZoneResponse> {
    this.validateMembers(dto);

    const topology = await readPlantTopology(this.kernelApi);
    if (!topology) {
      throw new ServiceUnavailableException(
        'Không thể đọc bản đồ đang tải trên hệ thống điều khiển — chưa xác định được khu vực thuộc bản đồ nào.',
      );
    }

    if (dto.type === ZoneType.DROPOFF) {
      this.assertDropoffZoneReachable(
        topology,
        dto.members.map((member) => member.locationName),
      );
    }

    const color = dto.color ?? (await this.pickDefaultColor());
    const memberLocationNames = dto.members.map(
      (member) => member.locationName,
    );
    const activeRecordId = await this.activeMapRecords.resolveId();
    if (!activeRecordId) {
      throw new ServiceUnavailableException(
        'Hãy nạp bản đồ từ Thư viện trước khi tạo khu vực.',
      );
    }
    this.assertRecordScope(activeRecordId, mapIds);
    await this.assertZoneNameAvailable(this.zoneRepo, dto.name, activeRecordId);
    await this.assertMemberLocationsAvailable(
      this.memberRepo,
      memberLocationNames,
      activeRecordId,
    );

    const savedZoneId = await this.dataSource.transaction(async (manager) => {
      const zoneRepo = manager.getRepository(ZoneEntity);
      const memberRepo = manager.getRepository(ZoneMemberEntity);

      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
        [`zone-name:${activeRecordId}:${dto.name}`],
      );
      for (const locationName of [...new Set(memberLocationNames)].sort()) {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          [`zone-location:${activeRecordId}:${locationName}`],
        );
      }
      await this.assertZoneNameAvailable(zoneRepo, dto.name, activeRecordId);
      await this.assertMemberLocationsAvailable(
        memberRepo,
        memberLocationNames,
        activeRecordId,
      );

      let kernelId: number | null = null;

      if (dto.type === ZoneType.DROPOFF) {
        const rows = await manager.query<[{ id: string }]>(
          `SELECT nextval('zone_kernel_id_seq') AS id`,
        );
        kernelId = Number(rows[0].id);
      }

      const zone = zoneRepo.create({
        name: dto.name,
        type: dto.type,
        color,
        operation: dto.operation ?? null,
        maxVehicles: dto.maxVehicles ?? null,
        kernelId,
        plantModelName: topology.name,
        mapRecordId: activeRecordId,
        status: ZoneStatus.ACTIVE,
      });

      const saved = await zoneRepo.save(zone);
      const members = dto.members.map((member) =>
        memberRepo.create({
          zoneId: saved.id,
          locationName: member.locationName,
          positionIndex: member.positionIndex,
        }),
      );
      await memberRepo.save(members);

      return saved.id;
    });

    await this.projectNewZoneToKernel(savedZoneId, dto, memberLocationNames);

    const saved = await this.zoneRepo.findOneOrFail({
      where: { id: savedZoneId },
      relations: { members: true },
    });
    return toZoneResponse(saved);
  }

  async update(
    id: string,
    dto: UpdateZoneDto,
    mapIds?: string[],
  ): Promise<ZoneResponse> {
    const zone = await this.zoneRepo.findOne({
      where: { id },
      relations: { members: true },
    });
    if (!zone) {
      throw new NotFoundException('Khu vực không tồn tại.');
    }
    this.assertRecordScope(zone.mapRecordId, mapIds);
    if (dto.name !== undefined && dto.name !== zone.name) {
      await this.assertZoneNameAvailable(
        this.zoneRepo,
        dto.name,
        zone.mapRecordId,
        zone.id,
      );
      zone.name = dto.name;
    }
    if (dto.color !== undefined) zone.color = dto.color;
    if (dto.operation !== undefined) zone.operation = dto.operation;
    if (dto.maxVehicles !== undefined) zone.maxVehicles = dto.maxVehicles;
    return toZoneResponse(await this.saveKeepingNameUnique(zone));
  }

  private async projectNewZoneToKernel(
    zoneId: string,
    dto: CreateZoneDto,
    memberLocationNames: string[],
  ): Promise<void> {
    try {
      await this.locationWriter.write(
        this.locationWriter.specsFor(
          memberLocationNames,
          this.locationWriter.kernelTypeOf(dto.type),
        ),
      );
    } catch (err) {
      await this.zoneRepo.update(zoneId, { status: ZoneStatus.STALE });
      this.logger.warn(
        `Zone "${dto.name}" (${zoneId}) saved, but its locations could not be written to the kernel — marked STALE, run sync to repair: ${(err as Error).message}`,
      );
    }
  }

  private async pickDefaultColor(): Promise<string> {
    const zones = await this.zoneRepo.find({
      where: { status: ZoneStatus.ACTIVE },
      select: { id: true, color: true },
    });
    return pickLeastUsedColor(
      ZONE_COLOR_PALETTE,
      zones.reduce<string[]>((colors, zone) => {
        if (zone.color) colors.push(zone.color);
        return colors;
      }, []),
    );
  }

  private canRepairZone(
    zone: ZoneEntity,
    pointNames: ReadonlySet<string>,
  ): boolean {
    if (zone.members.length === 0) return false;
    return zone.members.every((member) =>
      pointNames.has(pointNameOf(member.locationName)),
    );
  }

  private assertDropoffZoneReachable(
    topology: PlantTopology,
    memberLocationNames: string[],
  ): void {
    const review = reviewDropoffLayout(
      topology.points,
      topology.paths,
      memberLocationNames,
      topology.laneAxis,
    );

    if (review.noFeeder) {
      this.logger.warn(
        `Zone reachability: no feeder (entry head) for members [${memberLocationNames.join(', ')}] — cannot verify; approach will link all members`,
      );
      return;
    }

    if (review.longDetour) {
      this.logger.warn(
        `Zone reachability: layout reachable but with a long detour (maxHops=${review.longDetour.maxHops}, members=${review.longDetour.members})`,
      );
    }

    for (const problem of review.problems) {
      throw new BadRequestException(this.layoutProblemMessage(problem));
    }
  }

  private layoutProblemMessage(problem: LayoutProblem): string {
    if (problem.kind === 'unreachable') {
      return `Layout khu trả hàng không hợp lệ: các vị trí ${problem.locationNames.join(', ')} không thể tới được từ điểm vào của khu — sẽ khiến AGV đi vòng hoặc kẹt. Hãy điều chỉnh danh sách vị trí hoặc bản đồ.`;
    }
    return `Layout khu trả hàng không hợp lệ: ${problem.violations
      .map((violation) => `${violation.code} — ${violation.detail}`)
      .join('; ')}. Hãy điều chỉnh danh sách vị trí hoặc bản đồ.`;
  }

  async list(
    options: { allMaps?: boolean; mapIds?: string[] } = {},
  ): Promise<ZoneListItemResponse[]> {
    const zones = options.allMaps
      ? await this.zoneRepo.find({
          ...(options.mapIds !== undefined
            ? { where: { mapRecordId: In(options.mapIds) } }
            : {}),
          relations: { members: true },
          order: { createdAt: 'DESC' },
        })
      : await this.loadedMapZones(options.mapIds);

    if (zones.length === 0) return [];

    const occupiedByZone = await this.usage.occupiedByZone(
      zones.map((zone) => zone.id),
    );

    return zones.map((z) => ({
      ...toZoneResponse(z),
      occupiedSlotCount: occupiedByZone.get(z.id) ?? 0,
      totalSlotCount: z.members.length,
    }));
  }

  async remove(id: string, mapIds?: string[]): Promise<void> {
    const zone = await this.zoneRepo.findOne({
      where: { id },
      relations: { members: true },
    });
    if (!zone) {
      throw new NotFoundException('Khu vực không tồn tại.');
    }

    this.assertRecordScope(zone.mapRecordId, mapIds);
    if (await this.belongsToLoadedMap(zone)) {
      await this.locationWriter.removeUnshared(zone);
    }
    await this.zoneRepo.softDelete(id);
  }

  private async belongsToLoadedMap(zone: ZoneEntity): Promise<boolean> {
    const activeRecordId = await this.activeMapRecords.resolveId();
    return activeRecordId !== null && zone.mapRecordId === activeRecordId;
  }

  /**
   * The loaded map's zones, scoped at the query itself — not loaded-then-filtered in memory.
   * A list endpoint that pulls every row across every map just to discard most of them is
   * exactly the "list query leaks out-of-scope data" shape the plan's authorization risk section
   * calls out; this keeps the scoping condition in the WHERE clause instead.
   */
  private async loadedMapZones(mapIds?: string[]): Promise<ZoneEntity[]> {
    const activeRecordId = await this.activeMap.id();
    if (activeRecordId === null) return [];
    if (mapIds !== undefined && !mapIds.includes(activeRecordId)) return [];
    return this.zoneRepo.find({
      where: { mapRecordId: activeRecordId },
      relations: { members: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Stamps zones with the loaded plant model. This is deliberately an explicit
   * operator action: maps routinely share point names, so a zone whose points
   * all exist in the loaded map is NOT evidence that it was drawn there.
   */
  async assignToLoadedMap(
    zoneIds: string[],
    mapIds?: string[],
  ): Promise<AssignMapResult> {
    const [topology, activeRecordId] = await Promise.all([
      readPlantTopology(this.kernelApi),
      this.activeMapRecords.resolveId(),
    ]);
    if (!topology) {
      throw new ServiceUnavailableException(
        'Không thể đọc bản đồ đang tải trên hệ thống điều khiển.',
      );
    }
    if (!activeRecordId) {
      throw new ServiceUnavailableException(
        `Bản đồ "${topology.name}" đang tải trên hệ thống điều khiển không khớp bản ghi nào trong Thư viện bản đồ của WES — hãy nạp lại đúng bản đồ từ Thư viện trước khi gán khu vực.`,
      );
    }

    this.assertRecordScope(activeRecordId, mapIds);
    const zones = await this.zoneRepo.find({
      where: { id: In(zoneIds) },
      relations: { members: true },
    });
    if (zones.length === 0) {
      throw new NotFoundException('Không tìm thấy khu vực nào để gán.');
    }

    // Check caller scope before reporting conflicts from another map.
    for (const zone of zones) this.assertRecordScope(zone.mapRecordId, mapIds);

    const selectedNames = zones.map((zone) => zone.name);
    const duplicateSelectedNames = new Set(
      selectedNames.filter(
        (name, index) => selectedNames.indexOf(name) !== index,
      ),
    );
    if (duplicateSelectedNames.size > 0) {
      throw new ConflictException(
        `Cannot assign zones with duplicate names to the same map: ${[
          ...duplicateSelectedNames,
        ].join(', ')}.`,
      );
    }
    for (const zone of zones) {
      await this.assertZoneNameAvailable(
        this.zoneRepo,
        zone.name,
        activeRecordId,
        zone.id,
      );
    }
    const selectedLocations = zones.flatMap((zone) =>
      zone.members.map((member) => member.locationName),
    );
    const duplicateSelectedLocations = new Set(
      selectedLocations.filter(
        (locationName, index) =>
          selectedLocations.indexOf(locationName) !== index,
      ),
    );
    if (duplicateSelectedLocations.size > 0) {
      throw new ConflictException(
        `Cannot assign zones with duplicate locations to the same map: ${[
          ...duplicateSelectedLocations,
        ].join(', ')}.`,
      );
    }
    await this.assertMemberLocationsAvailable(
      this.memberRepo,
      selectedLocations,
      activeRecordId,
      new Set(zones.map((zone) => zone.id)),
    );

    // Both the source resources and destination must be allowed, before any write.
    const offMap = zones.filter(
      (zone) => !this.canRepairZone(zone, topology.pointNames),
    );
    if (offMap.length > 0) {
      const names = offMap.map((zone) => `"${zone.name}"`).join(', ');
      throw new BadRequestException(
        `Không thể gán ${names} vào bản đồ "${topology.name}": khu vực có vị trí không tồn tại trên bản đồ này.`,
      );
    }

    const assignedIds = zones.map((zone) => zone.id);
    await this.assertNamesFreeOnMap(zones, assignedIds, activeRecordId);
    try {
      await this.zoneRepo.update(
        { id: In(assignedIds) },
        { plantModelName: topology.name, mapRecordId: activeRecordId },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'Two zones being assigned share a name on this map.',
        );
      }
      throw err;
    }
    for (const zone of zones) {
      zone.plantModelName = topology.name;
      zone.mapRecordId = activeRecordId;
      this.logger.log(
        `Zone "${zone.name}" (${zone.id}) assigned to map "${topology.name}"`,
      );
    }

    return { plantModelName: topology.name, assigned: zones.length };
  }

  /**
   * Recreates zones/stores drawn on another map record onto the currently-loaded map: new ids,
   * new `mapRecordId`/`plantModelName`, a fresh `kernelId` for stores, same settings and member
   * locations (matched by point name). Meant for switching to a revised map while keeping the
   * old layout. The source zones are left untouched. Zones that cannot live on the loaded map
   * (missing points, name/location clash, unreachable drop-off layout) are skipped with a reason
   * instead of failing the whole batch.
   */
  async copyFromMap(
    sourceMapRecordId: string,
    zoneIds: string[] | undefined,
    mapIds?: string[],
  ): Promise<CopyFromMapResult> {
    const [topology, activeRecordId] = await Promise.all([
      readPlantTopology(this.kernelApi),
      this.activeMapRecords.resolveId(),
    ]);
    if (!topology) {
      throw new ServiceUnavailableException(
        'Không thể đọc bản đồ đang tải trên hệ thống điều khiển.',
      );
    }
    if (!activeRecordId) {
      throw new ServiceUnavailableException(
        'Hãy nạp bản đồ đích từ Thư viện trước khi sao chép khu vực.',
      );
    }
    this.assertRecordScope(activeRecordId, mapIds);
    this.assertRecordScope(sourceMapRecordId, mapIds);
    if (sourceMapRecordId === activeRecordId) {
      throw new BadRequestException(
        'Bản đồ nguồn trùng với bản đồ đang tải — hãy chọn bản đồ khác.',
      );
    }

    const sourceZones = await this.zoneRepo.find({
      where: {
        mapRecordId: sourceMapRecordId,
        ...(zoneIds ? { id: In(zoneIds) } : {}),
      },
      relations: { members: true },
      order: { createdAt: 'ASC' },
    });
    if (sourceZones.length === 0) {
      throw new NotFoundException(
        'Không tìm thấy khu vực nào trên bản đồ nguồn để sao chép.',
      );
    }

    const targetZones = await this.zoneRepo.find({
      where: { mapRecordId: activeRecordId },
      relations: { members: true },
    });
    const byId = new Map(sourceZones.map((zone) => [zone.id, zone]));
    const plan = planZoneCopy(
      sourceZones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        memberLocationNames: sortedMembers(zone).map((m) => m.locationName),
      })),
      {
        pointNames: topology.pointNames,
        takenNames: new Set(targetZones.map((zone) => zone.name)),
        takenLocations: new Set(
          targetZones
            .filter((zone) => zone.status === ZoneStatus.ACTIVE)
            .flatMap((zone) => zone.members.map((m) => m.locationName)),
        ),
        extraProblem: (source) => {
          if (byId.get(source.id)?.type !== ZoneType.DROPOFF) return null;
          try {
            this.assertDropoffZoneReachable(topology, [
              ...source.memberLocationNames,
            ]);
            return null;
          } catch (err) {
            return (err as Error).message;
          }
        },
      },
    );

    const accepted = plan.accepted.map((source) => byId.get(source.id)!);
    if (accepted.length === 0) {
      return {
        plantModelName: topology.name,
        copied: [],
        skipped: plan.skipped,
        kernelWriteFailed: false,
      };
    }

    const copied = await this.dataSource.transaction(async (manager) => {
      const zoneRepo = manager.getRepository(ZoneEntity);
      const memberRepo = manager.getRepository(ZoneMemberEntity);
      const lockKeys = [
        ...accepted.map((zone) => `zone-name:${activeRecordId}:${zone.name}`),
        ...accepted.flatMap((zone) =>
          zone.members.map(
            (m) => `zone-location:${activeRecordId}:${m.locationName}`,
          ),
        ),
      ];
      for (const key of [...new Set(lockKeys)].sort()) {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          [key],
        );
      }

      const out: CopyFromMapResult['copied'] = [];
      for (const source of accepted) {
        await this.assertZoneNameAvailable(
          zoneRepo,
          source.name,
          activeRecordId,
        );
        await this.assertMemberLocationsAvailable(
          memberRepo,
          source.members.map((m) => m.locationName),
          activeRecordId,
        );
        let kernelId: number | null = null;
        if (source.type === ZoneType.DROPOFF) {
          const rows = await manager.query<[{ id: string }]>(
            `SELECT nextval('zone_kernel_id_seq') AS id`,
          );
          kernelId = Number(rows[0].id);
        }
        const saved = await zoneRepo.save(
          zoneRepo.create({
            name: source.name,
            type: source.type,
            color: source.color,
            operation: source.operation,
            maxVehicles: source.maxVehicles,
            kernelId,
            plantModelName: topology.name,
            mapRecordId: activeRecordId,
            status: ZoneStatus.ACTIVE,
          }),
        );
        await memberRepo.save(
          sortedMembers(source).map((member) =>
            memberRepo.create({
              zoneId: saved.id,
              locationName: member.locationName,
              positionIndex: member.positionIndex,
            }),
          ),
        );
        out.push({ sourceId: source.id, zoneId: saved.id, name: saved.name });
      }
      return out;
    });

    let kernelWriteFailed = false;
    try {
      await this.locationWriter.write(
        accepted.flatMap((zone) =>
          this.locationWriter.specsFor(
            this.zoneMemberLocationNames(zone),
            this.locationWriter.kernelTypeOf(zone.type),
          ),
        ),
      );
    } catch (err) {
      kernelWriteFailed = true;
      await this.zoneRepo.update(
        { id: In(copied.map((c) => c.zoneId)) },
        { status: ZoneStatus.STALE },
      );
      this.logger.warn(
        `Copied ${copied.length} zone(s) onto "${topology.name}", but their locations could not be written to the kernel — marked STALE, run sync to repair: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Copied ${copied.length} zone(s) from map record ${sourceMapRecordId} onto "${topology.name}" (${plan.skipped.length} skipped)`,
    );
    return {
      plantModelName: topology.name,
      copied,
      skipped: plan.skipped,
      kernelWriteFailed,
    };
  }

  /**
   * Reconciles WES zones with the kernel's current map.
   *
   * Rules:
   * - Only zones belonging to the loaded plant model are reconciled. Zones drawn
   *   on another map — and zones not assigned to any map yet — are left
   *   untouched, so switching maps never invalidates them (STALE is one-way, see
   *   below) and no zone is ever silently claimed by the wrong map.
   * - A member location may belong to at most one ACTIVE zone.
   * - Sync never resurrects a STALE zone: only currently-ACTIVE zones are
   *   candidates to stay ACTIVE.
   * - A candidate whose member points are gone → STALE (unrepairable).
   * - If two or more candidates share a member location, all of them → STALE
   *   (an unresolved conflict to be sorted out manually).
   * - Surviving winners keep ACTIVE and have their missing locations rebuilt in a
   *   single PUT. If the kernel rejects the write (e.g. read-only/OPERATING), the
   *   zones that needed rebuilding fall back to STALE.
   */
  async sync(mapIds?: string[]): Promise<SyncResult> {
    // Sync may rewrite the kernel map, so always read it fresh (not from cache).
    this.kernelApi.invalidatePlantModelCache();
    const [topology, activeRecordId] = await Promise.all([
      readPlantTopology(this.kernelApi),
      this.activeMapRecords.resolveId(),
    ]);

    if (!topology) {
      this.logger.warn('Sync skipped: kernel unreachable');
      return {
        plantModelName: null,
        total: 0,
        markedStale: 0,
        markedActive: 0,
        skippedOtherMaps: 0,
        unassigned: 0,
        kernelUnreachable: true,
      };
    }

    this.assertRecordScope(activeRecordId, mapIds);
    const allZones = await this.zoneRepo.find({ relations: { members: true } });
    const zones = activeRecordId
      ? allZones.filter((zone) => zone.mapRecordId === activeRecordId)
      : [];
    const unassigned = allZones.filter((zone) => !zone.mapRecordId).length;
    const skippedOtherMaps = allZones.length - zones.length - unassigned;

    const plan = this.planFor(zones, topology);
    const desiredStatus = await this.applyRebuilds(plan, zones, topology);

    const changedByStatus = new Map<ZoneStatus, ZoneEntity[]>();
    for (const zone of zones) {
      const targetStatus = toZoneStatus(desiredStatus.get(zone.id) ?? 'STALE');
      if (zone.status === targetStatus) continue;
      zone.status = targetStatus;
      changedByStatus.set(targetStatus, [
        ...(changedByStatus.get(targetStatus) ?? []),
        zone,
      ]);
    }
    for (const [status, changed] of changedByStatus) {
      await this.zoneRepo.update(
        { id: In(changed.map((zone) => zone.id)) },
        { status },
      );
    }

    const markedStale = changedByStatus.get(ZoneStatus.STALE) ?? [];
    const markedActive = changedByStatus.get(ZoneStatus.ACTIVE) ?? [];
    for (const zone of markedStale) {
      this.logger.warn(`Zone "${zone.name}" (${zone.id}) marked STALE`);
    }
    for (const zone of markedActive) {
      this.logger.log(`Zone "${zone.name}" (${zone.id}) restored to ACTIVE`);
    }

    return {
      plantModelName: topology.name,
      total: zones.length,
      markedStale: markedStale.length,
      markedActive: markedActive.length,
      skippedOtherMaps,
      unassigned,
      kernelUnreachable: false,
    };
  }

  private planFor(zones: ZoneEntity[], topology: PlantTopology) {
    const candidates: SyncCandidate[] = zones.map((zone) => ({
      id: zone.id,
      status: zone.status === ZoneStatus.ACTIVE ? 'ACTIVE' : 'STALE',
      memberLocationNames: this.zoneMemberLocationNames(zone),
    }));
    return planZoneSync(candidates, {
      pointNames: topology.pointNames,
      locationLinks: topology.locationLinks,
    });
  }

  private async applyRebuilds(
    plan: ReturnType<typeof planZoneSync>,
    zones: ZoneEntity[],
    topology: PlantTopology,
  ): Promise<ReadonlyMap<string, SyncStatus>> {
    const toRebuild = zones.filter((zone) => plan.rebuildIds.has(zone.id));
    if (toRebuild.length === 0) return plan.desiredStatus;

    const specs = toRebuild.flatMap((zone) =>
      this.locationWriter.specsFor(
        this.zoneMemberLocationNames(zone),
        this.locationWriter.kernelTypeOf(zone.type),
      ),
    );
    try {
      await this.locationWriter.write(specs);
      return plan.desiredStatus;
    } catch (err) {
      this.logger.warn(
        `Không thể ghi location khôi phục cho bản đồ "${topology.name}" (kernel cần chế độ Thiết kế?): ${(err as Error).message}`,
      );
      return withRebuildsFailed(plan).desiredStatus;
    }
  }

  private zoneMemberLocationNames(zone: ZoneEntity): string[] {
    return [...new Set(zone.members.map((member) => member.locationName))];
  }

  private validateMembers(dto: CreateZoneDto): void {
    const locationNames = dto.members.map((member) => member.locationName);
    const uniqueNames = new Set(locationNames);
    if (uniqueNames.size !== locationNames.length) {
      throw new BadRequestException('Duplicate locationName in members.');
    }

    const positionIndexes = dto.members.map((member) => member.positionIndex);
    const uniqueIndexes = new Set(positionIndexes);
    if (uniqueIndexes.size !== positionIndexes.length) {
      throw new BadRequestException('Duplicate positionIndex in members.');
    }
  }

  private async assertNamesFreeOnMap(
    zones: readonly ZoneEntity[],
    zoneIds: readonly string[],
    mapRecordId: string | null,
  ): Promise<void> {
    if (!mapRecordId) return;
    const clash = await this.zoneRepo.findOne({
      where: {
        mapRecordId,
        name: In(zones.map((zone) => zone.name)),
        id: Not(In([...zoneIds])),
      },
    });
    if (clash) {
      throw new ConflictException(
        `Zone name "${clash.name}" already exists in this map.`,
      );
    }
  }

  private async saveKeepingNameUnique(zone: ZoneEntity): Promise<ZoneEntity> {
    try {
      return await this.zoneRepo.save(zone);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `Zone name "${zone.name}" already exists in this map.`,
        );
      }
      throw err;
    }
  }

  private async assertZoneNameAvailable(
    zoneRepo: Repository<ZoneEntity>,
    name: string,
    mapRecordId: string | null,
    excludedZoneId?: string,
  ): Promise<void> {
    if (!mapRecordId) return;
    const existing = await zoneRepo.findOne({
      where: { name, mapRecordId },
    });
    if (existing && existing.id !== excludedZoneId) {
      throw new ConflictException(
        `Zone name "${name}" already exists in this map.`,
      );
    }
  }

  private async assertMemberLocationsAvailable(
    memberRepo: Repository<ZoneMemberEntity>,
    locationNames: string[],
    mapRecordId: string | null,
    excludedZoneIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (!mapRecordId || locationNames.length === 0) return;
    const existingMembers = await memberRepo.find({
      where: { locationName: In([...new Set(locationNames)]) },
      relations: { zone: true },
    });
    const conflict = existingMembers.find(
      (member) =>
        member.zone?.mapRecordId === mapRecordId &&
        member.zone.status === ZoneStatus.ACTIVE &&
        !excludedZoneIds.has(member.zoneId),
    );
    if (conflict) {
      throw new ConflictException(
        `Location "${conflict.locationName}" is already assigned to another zone in this map.`,
      );
    }
  }
}

function sortedMembers(zone: ZoneEntity): ZoneMemberEntity[] {
  return [...zone.members].sort((a, b) => a.positionIndex - b.positionIndex);
}

function toZoneStatus(status: SyncStatus): ZoneStatus {
  return status === 'ACTIVE' ? ZoneStatus.ACTIVE : ZoneStatus.STALE;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string } | undefined)?.code === '23505'
  );
}
