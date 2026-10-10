import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CargoService, SourceAvailability } from '../cargo/cargo.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  ZoneEntity,
  ZoneStatus,
  ZoneType,
} from '../zones/entities/zone.entity';
import {
  LEGACY_PERMISSION_DENIED,
  LegacyFmsError,
  LegacyFmsErrorDef,
  LegacyFmsException,
} from './legacy-fms.errors';
import {
  LegacyCargoDto,
  parseLegacyCargoRequest,
  toLegacyCargo,
} from './legacy-fms.mapping';

const SOURCE_REJECTIONS: Record<
  Exclude<SourceAvailability, 'AVAILABLE'>,
  LegacyFmsErrorDef
> = {
  POINT_NOT_FOUND: LegacyFmsError.POSITION_NOT_FOUND,
  NOT_PICKUP_POINT: LegacyFmsError.NOT_CARGO_POSITION,
  OCCUPIED_BY_CARGO: LegacyFmsError.POSITION_OCCUPIED_BY_CARGO,
  LANE_COMMITTED: LegacyFmsError.POSITION_OCCUPIED_BY_VEHICLE,
};

@Injectable()
export class LegacyFmsCargoService {
  constructor(
    private readonly cargo: CargoService,
    private readonly activeMap: ActiveMapContext,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
  ) {}

  async createCargo(
    body: unknown,
    userId: string,
    mapIds?: string[],
  ): Promise<LegacyCargoDto> {
    const request = parseLegacyCargoRequest(body);
    const loadedMapId = await this.loadedMapIdInScope(mapIds);
    const zone = await this.requireDestinationWithRoom(
      request.destination,
      loadedMapId,
    );
    await this.requireSourceAvailable(request.position);

    const created = await this.cargo
      .create(
        {
          itemCode: request.name,
          sourcePointName: request.position,
          destinationZoneId: zone.id,
        },
        userId,
      )
      .catch((error: unknown) => {
        throw error instanceof ConflictException
          ? new LegacyFmsException(LegacyFmsError.NAME_EXISTS)
          : error;
      });

    return toLegacyCargo(await this.cargo.findOne(created.id), zone.name);
  }

  async assertPositionAvailable(
    position: string,
    mapIds?: string[],
  ): Promise<{ 'Position available': true }> {
    await this.loadedMapIdInScope(mapIds);
    await this.requireSourceAvailable(position);
    return { 'Position available': true };
  }

  async assertDestinationAvailable(
    destination: string,
    mapIds?: string[],
  ): Promise<{ 'Destination available': true }> {
    const loadedMapId = await this.loadedMapIdInScope(mapIds);
    await this.requireDestinationWithRoom(destination, loadedMapId);
    return { 'Destination available': true };
  }

  private async requireSourceAvailable(position: string): Promise<void> {
    const availability = await this.cargo.inspectSource(position);
    if (availability !== 'AVAILABLE') {
      throw new LegacyFmsException(SOURCE_REJECTIONS[availability]);
    }
  }

  private async requireDestinationWithRoom(
    dropoffAreaName: string,
    loadedMapId: string,
  ): Promise<ZoneEntity> {
    const zone = await this.zoneRepo.findOne({
      where: { mapRecordId: loadedMapId, name: dropoffAreaName },
      relations: { members: true },
    });
    if (!zone || zone.status !== ZoneStatus.ACTIVE) {
      throw new LegacyFmsException(LegacyFmsError.LOCATION_NOT_FOUND);
    }
    if (zone.type !== ZoneType.DROPOFF) {
      throw new LegacyFmsException(
        LegacyFmsError.LOCATION_NOT_DESTINATION_TYPE,
      );
    }
    if (!(await this.cargo.hasRoomIn(zone))) {
      throw new LegacyFmsException(LegacyFmsError.DESTINATION_FULL);
    }
    return zone;
  }

  private async loadedMapIdInScope(mapIds?: string[]): Promise<string> {
    const loadedMapId = await this.activeMap.id();
    if (!loadedMapId) {
      throw new ServiceUnavailableException(
        'Không thể đọc bản đồ đang tải trên hệ thống điều khiển.',
      );
    }
    if (mapIds !== undefined && !mapIds.includes(loadedMapId)) {
      throw new ForbiddenException(LEGACY_PERMISSION_DENIED);
    }
    return loadedMapId;
  }
}
