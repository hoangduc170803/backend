import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, IsNull, Not, Repository } from 'typeorm';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { parseOpenTcsXml } from '../../opentcs/map-loader/opentcs-xml.parser';
import { PlantModelWriter } from '../../opentcs/plant-model-writer.service';
import { MapRecordEntity } from '../infrastructure/entities/map-record.entity';
import { ZoneEntity } from '../../zones/entities/zone.entity';
import { ZoneService } from '../../zones/zone.service';
import { ActiveMapRecordService } from '../infrastructure/active-map-record.service';
import { FMS_EVENTS, FmsMapLoadedEvent } from '../../cargo/domain/events';
import {
  areasForMap,
  CURRENT_PREVIEW_VERSION,
  previewOf,
  toLibraryItem,
  type MapLibraryDetailDto,
  type MapLibraryItemDto,
} from '../domain/map-preview';

/**
 * The map library: uploaded XML plant models stored in WES, independent of whatever the kernel
 * currently has loaded. `KernelMapService` owns the live kernel state; this service owns the
 * stored records and the one action that pushes one of them into the kernel (`loadLibraryMap`).
 */
@Injectable()
export class MapLibraryService {
  private readonly logger = new Logger(MapLibraryService.name);
  private loadQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly kernelApi: KernelApiService,
    @InjectRepository(MapRecordEntity)
    private readonly repo: Repository<MapRecordEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly zoneService: ZoneService,
    private readonly activeMapRecords: ActiveMapRecordService,
    private readonly eventEmitter: EventEmitter2,
    private readonly plantModelWriter: PlantModelWriter,
  ) {}

  /** `mapIds`: the caller's AUTH-3 map scope (`undefined` = unrestricted — see `ability.ts`). */
  async listLibrary(mapIds?: string[]): Promise<MapLibraryItemDto[]> {
    const records = await this.repo.find({
      where: {
        xmlContent: Not(IsNull()),
        ...(mapIds !== undefined ? { id: In(mapIds) } : {}),
      },
      order: { uploadedAt: 'DESC' },
    });
    if (records.length === 0) return [];

    await this.refreshStalePreviews(records);

    const [activeId, zones] = await Promise.all([
      this.activeMapRecords.resolveId(),
      this.zoneRepo.find({
        where: { mapRecordId: In(records.map((record) => record.id)) },
        relations: { members: true },
      }),
    ]);
    return records.map((record) =>
      toLibraryItem(
        record,
        record.id === activeId,
        areasForMap(record.id, zones),
      ),
    );
  }

  async getLibraryMap(
    id: string,
    mapIds?: string[],
  ): Promise<MapLibraryDetailDto> {
    const record = await this.storedMap(id, mapIds);
    const model = this.parseXml(record.xmlContent as string);
    if (record.preview?.previewVersion !== CURRENT_PREVIEW_VERSION) {
      record.preview = previewOf(model);
      await this.repo.update({ id: record.id }, { preview: record.preview });
    }
    const [activeId, zones] = await Promise.all([
      this.activeMapRecords.resolveId(),
      this.zoneRepo.find({
        where: { mapRecordId: record.id },
        relations: { members: true },
      }),
    ]);

    return {
      ...toLibraryItem(
        record,
        record.id === activeId,
        areasForMap(record.id, zones),
      ),
      points: model.points.map((point) => ({
        name: point.name,
        type: point.type,
        x: point.position.x,
        y: point.position.y,
        z: point.position.z,
      })),
      paths: model.paths.map((path) => ({
        name: path.name,
        source: path.srcPointName,
        target: path.destPointName,
        length: path.length,
        locked: path.locked,
      })),
      locations: model.locations.map((location) => ({
        name: location.name,
        type: location.typeName,
        pointNames: location.links.map((link) => link.pointName),
      })),
      vehicles: model.vehicles.map((vehicle) => vehicle.name),
      blocks: model.blocks.map((block) => ({
        name: block.name,
        type: block.type,
        memberNames: block.memberNames,
      })),
    };
  }

  async getLibraryXml(
    id: string,
    mapIds?: string[],
  ): Promise<{ filename: string; content: string }> {
    const record = await this.storedMap(id, mapIds);
    return {
      filename: record.originalFilename,
      content: record.xmlContent as string,
    };
  }

  async uploadToLibrary(
    xmlBuffer: Buffer,
    originalFilename: string,
    uploadedById: string,
  ): Promise<MapLibraryItemDto> {
    const xmlContent = xmlBuffer.toString('utf-8');

    let model: ReturnType<typeof parseOpenTcsXml>;
    try {
      model = parseOpenTcsXml(xmlContent);
    } catch (err) {
      throw new BadRequestException(
        `File XML không hợp lệ: ${(err as Error).message}`,
      );
    }

    if (!model.name?.trim()) {
      throw new BadRequestException('File XML không có tên plant model.');
    }

    // Auto-generation of single-vehicle lane blocks (SVB-*) DISABLED.
    // Previously WES derived SINGLE_VEHICLE_ONLY blocks from the path graph to
    // serialise single-file / dead-end lanes; only hand-authored blocks in the
    // uploaded XML are kept now.
    // const blockCount = applySingleVehicleBlocks(model).blocks.length;
    // this.logger.log(`Generated ${blockCount} single-vehicle lane block(s)`);

    const record = this.repo.create({
      name: model.name.trim(),
      originalFilename: originalFilename || `${model.name.trim()}.xml`,
      pointCount: model.points.length,
      pathCount: model.paths.length,
      vehicleCount: model.vehicles.length,
      locationCount: model.locations.length,
      blockCount: model.blocks.length,
      xmlContent,
      preview: previewOf(model),
      uploadedById,
      lastLoadedAt: null,
    });
    return toLibraryItem(await this.repo.save(record), false);
  }

  async loadLibraryMap(
    id: string,
    mapIds?: string[],
  ): Promise<MapLibraryItemDto> {
    return this.afterPendingLibraryWrites(() => this.loadRecord(id, mapIds));
  }

  async deleteLibraryMap(
    id: string,
    deletedById: string,
    mapIds?: string[],
  ): Promise<void> {
    return this.afterPendingLibraryWrites(() =>
      this.deleteRecord(id, deletedById, mapIds),
    );
  }

  private async afterPendingLibraryWrites<T>(
    write: () => Promise<T>,
  ): Promise<T> {
    const previous = this.loadQueue;
    let release!: () => void;
    this.loadQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await write();
    } finally {
      release();
    }
  }

  private async deleteRecord(
    id: string,
    deletedById: string,
    mapIds?: string[],
  ): Promise<void> {
    const record = await this.storedMap(id, mapIds);
    const activeId = await this.activeMapRecords.resolveId();
    if (activeId === record.id) {
      throw new ConflictException(
        'Bản đồ đang được nạp trong trung tâm điều phối. Hãy nạp bản đồ khác trước khi xoá.',
      );
    }
    const kernelModelKnown =
      activeId !== null || (await this.kernelApi.getRawPlantModel()) != null;
    if (!kernelModelKnown) {
      throw new ConflictException(
        'Không đọc được bản đồ đang chạy trên trung tâm điều phối nên chưa thể xác nhận bản đồ này không còn được dùng. Hãy thử lại khi trung tâm điều phối hoạt động.',
      );
    }

    await this.repo.softDelete({ id: record.id });
    this.logger.log(
      `Deleted stored map "${record.name}" (${record.id}) from the library by user ${deletedById}`,
    );
  }

  private async loadRecord(
    id: string,
    mapIds?: string[],
  ): Promise<MapLibraryItemDto> {
    const record = await this.storedMap(id, mapIds);
    const model = this.parseXml(record.xmlContent as string);

    let saved!: MapRecordEntity;
    await this.plantModelWriter.replace(model, {
      reason: `map "${record.name}" loaded`,
      vehicles: 'initialize',
      afterWrite: async () => {
        record.lastLoadedAt = new Date();
        saved = await this.repo.save(record);
      },
    });

    const zoneSync = await this.zoneService.sync().catch((error) => {
      this.logger.warn(
        `Zone sync after loading "${record.name}" failed: ${(error as Error).message}`,
      );
      return null;
    });
    if (zoneSync) {
      this.logger.log(
        `Zone sync after loading "${record.name}": ${zoneSync.markedActive} active, ${zoneSync.markedStale} stale`,
      );
    }

    this.logger.log(
      `Loaded stored map "${saved.name}" (${saved.id}) into the kernel`,
    );
    this.eventEmitter.emit(
      FMS_EVENTS.MAP_LOADED,
      new FmsMapLoadedEvent(saved.id),
    );

    const zones = await this.zoneRepo.find({
      where: { mapRecordId: saved.id },
      relations: { members: true },
    });
    return toLibraryItem(saved, true, areasForMap(saved.id, zones));
  }

  /**
   * Regenerate and persist the preview for any record whose cached version is behind
   * `CURRENT_PREVIEW_VERSION` (bumped whenever the parser/renderer changes) — including legacy
   * rows saved before this field existed. Mutates `records` in place so the caller's mapping
   * sees the fresh preview without a second read.
   */
  private async refreshStalePreviews(
    records: MapRecordEntity[],
  ): Promise<void> {
    const stale = records.filter(
      (record) => record.preview?.previewVersion !== CURRENT_PREVIEW_VERSION,
    );
    if (stale.length === 0) return;

    const withXml = await this.repo.find({
      where: { id: In(stale.map((record) => record.id)) },
      select: { id: true, xmlContent: true },
    });
    const xmlById = new Map(
      withXml.map((record) => [record.id, record.xmlContent]),
    );

    for (const record of stale) {
      const xmlContent = xmlById.get(record.id);
      if (!xmlContent) continue;
      try {
        record.preview = previewOf(parseOpenTcsXml(xmlContent));
        await this.repo.update({ id: record.id }, { preview: record.preview });
      } catch (err) {
        this.logger.warn(
          `Preview regeneration failed for map "${record.name}" (${record.id}): ${(err as Error).message}`,
        );
      }
    }
  }

  /** `mapIds`: the caller's AUTH-3 map scope (`undefined` = unrestricted — see `ability.ts`). */
  private async storedMap(
    id: string,
    mapIds?: string[],
  ): Promise<MapRecordEntity> {
    const record = await this.repo.findOne({
      where: { id },
      select: {
        id: true,
        name: true,
        originalFilename: true,
        pointCount: true,
        pathCount: true,
        vehicleCount: true,
        locationCount: true,
        blockCount: true,
        xmlContent: true,
        preview: true,
        uploadedAt: true,
        uploadedById: true,
        lastLoadedAt: true,
      },
    });
    if (!record?.xmlContent) {
      throw new NotFoundException('Không tìm thấy bản đồ đã lưu trong WES.');
    }
    if (mapIds !== undefined && !mapIds.includes(record.id)) {
      throw new ForbiddenException(
        'Vai trò của bạn không được gán quyền thao tác trên bản đồ này.',
      );
    }
    return record;
  }

  private parseXml(xmlContent: string): ReturnType<typeof parseOpenTcsXml> {
    try {
      return parseOpenTcsXml(xmlContent);
    } catch (err) {
      throw new BadRequestException(
        `File XML không hợp lệ: ${(err as Error).message}`,
      );
    }
  }
}
