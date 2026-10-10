import { Injectable } from '@nestjs/common';
import { Observable, from, mergeMap } from 'rxjs';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { VehicleStateStore } from '../../opentcs/vehicle-state.store';
import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import { batteryVoltageOf } from '../../opentcs/domain/vehicle-telemetry';
import {
  OperatingOrdersService,
  type RouteStep,
} from './operating-orders.service';
import type { VehicleRealtimeDto } from '../dto/operating.dto';

function toDto(vehicle: KernelVehicleState): VehicleRealtimeDto {
  const transportOrder = vehicle.transportOrder ?? null;
  return {
    name: vehicle.name,
    serialNumber: vehicle.properties?.['vda5050:serialNumber']?.trim() || null,
    x: vehicle.precisePosition?.x ?? null,
    y: vehicle.precisePosition?.y ?? null,
    orientationAngle:
      typeof vehicle.orientationAngle === 'number'
        ? vehicle.orientationAngle
        : null,
    currentPosition: vehicle.currentPosition ?? null,
    state: vehicle.state,
    procState: vehicle.procState,
    integrationLevel: vehicle.integrationLevel,
    energyLevel: vehicle.energyLevel,
    batteryVoltage: batteryVoltageOf(vehicle.properties),
    transportOrder,
    paused: vehicle.paused,
    reportedPaused:
      vehicle.properties?.['vda5050:paused'] === 'true'
        ? true
        : vehicle.properties?.['vda5050:paused'] === 'false'
          ? false
          : null,
    loaded: vehicle.loaded ?? false,
    fatalErrorCodes: vehicle.errors?.fatal ?? [],
    warningErrorCodes: vehicle.errors?.warning ?? [],
    errorDescriptions: vehicle.errors?.descriptions ?? {},
    routePoints: [],
    routeProgressPercent: 0,
    routeSteps: [],
    allocatedResources: (vehicle.allocatedResources ?? []).flat(),
  };
}

@Injectable()
export class OperatingVehiclesService {
  constructor(
    private readonly store: VehicleStateStore,
    private readonly kernelApi: KernelApiService,
    private readonly orders: OperatingOrdersService,
  ) {}

  async snapshot(): Promise<VehicleRealtimeDto[]> {
    const stored = this.store.getAll();
    const source =
      stored.length > 0 ? stored : await this.kernelApi.getVehicleStates();
    return Promise.all(source.map((vehicle) => this.withRoute(toDto(vehicle))));
  }

  enrich(vehicle: KernelVehicleState): Promise<VehicleRealtimeDto> {
    return this.withRoute(toDto(vehicle));
  }

  async currentStates(): Promise<KernelVehicleState[]> {
    const fromKernel = await this.kernelApi.getVehicleStates();
    return fromKernel.length > 0 ? fromKernel : this.store.getAll();
  }

  get states$(): Observable<KernelVehicleState> {
    return this.store.vehicleUpdates;
  }

  get updates$(): Observable<VehicleRealtimeDto> {
    return this.store.vehicleUpdates.pipe(
      mergeMap((vehicle) => from(this.withRoute(toDto(vehicle)))),
    );
  }

  private async withRoute(
    dto: VehicleRealtimeDto,
  ): Promise<VehicleRealtimeDto> {
    if (!dto.transportOrder) return dto;
    const { points, percent, steps } = await this.orders
      .routeProgress(dto.transportOrder)
      .catch(() => ({
        points: [] as string[],
        percent: 0,
        steps: [] as RouteStep[],
      }));
    return {
      ...dto,
      routePoints: points,
      routeProgressPercent: percent,
      routeSteps: steps,
    };
  }
}
