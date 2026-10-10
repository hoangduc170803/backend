import { ActiveMapRecordService } from '../infrastructure/active-map-record.service';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { TransportOrderService } from '../../opentcs/transport-order.service';
import { VehicleStateStore } from '../../opentcs/vehicle-state.store';
import type {
  KernelLocation,
  KernelLocationType,
  KernelVehicleState,
} from '../../opentcs/domain/kernel-model';
import { toKernelPlantModel } from '../../opentcs/domain/kernel-mappers';
import { plantModelToXml } from '../../opentcs/plant-model-to-xml';
import {
  buildMapHealthReport,
  type MapHealthReport,
  type MapHealthZone,
} from '../domain/map-health';
import { toPlantModelSummary } from '../domain/plant-model-summary';
import { MapRecordEntity } from '../infrastructure/entities/map-record.entity';
import { CargoEntity, CargoStatus } from '../../cargo/entities/cargo.entity';
import {
  ZoneEntity,
  ZoneStatus,
  ZoneType,
} from '../../zones/entities/zone.entity';

export type KernelMode = 'MODELLING' | 'OPERATING';

export interface KernelStatusDto {
  reachable: boolean;
  state: KernelMode | null;
}

export interface CurrentMapDto {
  name: string;
  pointCount: number;
  pathCount: number;
  vehicleCount: number;
  originalFilename: string | null;
  uploadedAt: Date | null;
  uploadedById: string | null;
}

function vehicleNamesOf(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const vehicles = (raw as { vehicles?: unknown }).vehicles;
  if (!Array.isArray(vehicles)) return [];
  return vehicles.flatMap((vehicle: unknown) => {
    if (!vehicle || typeof vehicle !== 'object') return [];
    const name = (vehicle as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

/**
 * Read-mostly passthrough onto whatever the kernel currently has loaded — status, health,
 * raw/XML plant model, cargo pickup/dropoff options, vehicle roster, and the low-level kernel
 * debug/event/transport-order endpoints the Operating screen's map tooling calls directly.
 * `MapLibraryService` owns the stored records this data gets cross-referenced against.
 */
@Injectable()
export class KernelMapService {
  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly transportOrders: TransportOrderService,
    private readonly vehicleStateStore: VehicleStateStore,
    @InjectRepository(MapRecordEntity)
    private readonly repo: Repository<MapRecordEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly activeMapRecords: ActiveMapRecordService,
  ) {}

  async getKernelStatus(): Promise<KernelStatusDto> {
    const [reachable, state] = await Promise.all([
      this.kernelApi.isReachable(),
      this.kernelApi.getKernelState(),
    ]);
    return { reachable, state };
  }

  async getPlantModel(): Promise<unknown> {
    const plantModel = await this.kernelApi.getRawPlantModel();
    return toPlantModelSummary(plantModel) ? plantModel : null;
  }

  async getHealth(): Promise<MapHealthReport | null> {
    const raw = await this.kernelApi.getRawPlantModel();
    const summary = toPlantModelSummary(raw);
    if (!summary) return null;

    const model = toKernelPlantModel(raw);
    if (!model) return null;

    return buildMapHealthReport({
      mapName: summary.name,
      points: model.points,
      paths: model.paths,
      locations: model.locations,
      locationTypes: model.locationTypes,
      chargeOperation: this.kernelApi.chargeOperation,
      loadOperation: this.kernelApi.loadOperation,
      unloadOperation: this.kernelApi.unloadOperation,
      vehicleNames: vehicleNamesOf(raw),
      zones: await this.zonesDrawnOn(),
    });
  }

  private async zonesDrawnOn(): Promise<MapHealthZone[]> {
    const mapRecordId = await this.activeMapRecords.resolveId();
    if (!mapRecordId) return [];
    const zones = await this.zoneRepo.find({
      where: { mapRecordId, status: ZoneStatus.ACTIVE },
    });
    return zones.map((zone) => ({
      name: zone.name,
      type: zone.type === ZoneType.PICKUP ? 'PICKUP' : 'DROPOFF',
      locationNames: [...zone.members]
        .sort((a, b) => a.positionIndex - b.positionIndex)
        .map((member) => member.locationName),
    }));
  }

  async getPlantModelXml(): Promise<string | null> {
    const plantModel = await this.kernelApi.getRawPlantModel();
    if (!toPlantModelSummary(plantModel)) return null;
    return plantModelToXml(plantModel);
  }

  async getKernelVehicles(): Promise<KernelVehicleState[]> {
    const vehicles = await this.kernelApi.getVehicleStates();
    return vehicles.map((vehicle) => ({
      ...vehicle,
      goal: this.vehicleStateStore.get(vehicle.name)?.goal ?? null,
    }));
  }

  async getKernelDebug(): Promise<unknown> {
    return this.kernelApi.getDebugSnapshot();
  }

  async withdrawTransportOrder(name: string): Promise<void> {
    await this.transportOrders.cancel(name);
  }

  async getCargoOptions(): Promise<{
    pickupLocations: { locationName: string; pointName: string }[];
    dropoffLocations: string[];
  }> {
    const [model, deliveredCargos] = await Promise.all([
      this.kernelApi.getPlantModelView(),
      this.cargoRepo.find({
        where: { status: CargoStatus.DELIVERED },
        select: { destinationLocationName: true },
      }),
    ]);
    if (!model) return { pickupLocations: [], dropoffLocations: [] };

    const locationTypes: KernelLocationType[] = model.locationTypes ?? [];
    const locations: KernelLocation[] = model.locations ?? [];
    const occupiedDropoffLocations = deliveredCargos.reduce((names, cargo) => {
      if (cargo.destinationLocationName)
        names.add(cargo.destinationLocationName);
      return names;
    }, new Set<string>());

    const pickupTypeNames = new Set<string>(
      locationTypes
        .filter((locationType) =>
          locationType.allowedOperations.includes(this.kernelApi.loadOperation),
        )
        .map((locationType) => locationType.name),
    );
    const dropoffTypeNames = new Set<string>(
      locationTypes
        .filter((locationType) =>
          locationType.allowedOperations.includes(
            this.kernelApi.unloadOperation,
          ),
        )
        .map((locationType) => locationType.name),
    );

    const pickupLocations: { locationName: string; pointName: string }[] = [];
    const dropoffLocations: string[] = [];

    for (const loc of locations) {
      const typeName: string = loc.typeName ?? loc.type ?? '';
      if (pickupTypeNames.has(typeName)) {
        const links = loc.links;
        let pointName = '';
        if (Array.isArray(links) && links.length > 0) {
          pointName = links[0].pointName ?? links[0].point ?? '';
        } else if (links && typeof links === 'object') {
          pointName = Object.keys(links)[0] ?? '';
        }
        if (pointName) {
          pickupLocations.push({ locationName: loc.name, pointName });
        }
      }
      if (dropoffTypeNames.has(typeName)) {
        if (!occupiedDropoffLocations.has(loc.name)) {
          dropoffLocations.push(loc.name);
        }
      }
    }

    return {
      pickupLocations: pickupLocations.sort((a, b) =>
        a.locationName.localeCompare(b.locationName),
      ),
      dropoffLocations: dropoffLocations.sort(),
    };
  }

  async proxyKernelEvents(
    minSequenceNo: number,
    timeout: number,
  ): Promise<unknown> {
    return this.kernelApi.getEvents(minSequenceNo, timeout);
  }

  async getCurrent(): Promise<CurrentMapDto | null> {
    const plantModel = toPlantModelSummary(
      await this.kernelApi.getRawPlantModel(),
    );
    if (!plantModel) {
      return null;
    }

    const latestRecord = await this.activeMapRecords.resolve();

    return {
      ...plantModel,
      originalFilename: latestRecord?.originalFilename ?? null,
      uploadedAt: latestRecord?.uploadedAt ?? null,
      uploadedById: latestRecord?.uploadedById ?? null,
    };
  }
}
