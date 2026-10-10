import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { PlantModelDto } from './map-loader/opentcs-xml.parser';
import type {
  CreateTransportOrderOptions,
  KernelChargeLocation,
  KernelParkingPoint,
  KernelPlantModel,
  KernelRoute,
  KernelTransportOrderSummary,
  KernelVehicleState,
  TransportOrderDestination,
  TransportOrderResponse,
} from './domain/kernel-model';
import {
  locationPointNames,
  toKernelPlantModel,
  toKernelVehicleStates,
  toTransportOrderDebugList,
  unusablePlantModelEntries,
} from './domain/kernel-mappers';
import { describeShift, alignPoints } from './domain/point-alignment';
import { vehicleOperationsFor } from './domain/vehicle-operations';
import { toVehicleCommandException } from './vehicle-command-error';

const ENVIRONMENTAL_ENTITY_TIMEOUT_MS = 5_000;

@Injectable()
export class KernelApiService {
  private readonly logger = new Logger(KernelApiService.name);
  private readonly baseUrl: string;
  readonly loadOperation: string;
  readonly unloadOperation: string;
  readonly chargeOperation: string;

  private cachedPlantModel: unknown = null;
  private cachedPlantModelView: KernelPlantModel | null = null;
  private plantModelViewSource: unknown = null;
  private plantModelFetch: Promise<unknown> | null = null;
  private plantModelGeneration = 0;

  constructor() {
    this.baseUrl = process.env.OPENTCS_KERNEL_URL ?? 'http://localhost:55200';
    const operations = vehicleOperationsFor(
      process.env.VEHICLE_TYPE ?? 'loopback',
    );
    this.loadOperation = operations.load;
    this.unloadOperation = operations.unload;
    this.chargeOperation = operations.charge;
  }

  async isReachable(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/v1/kernel/version`, { timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  async putPlantModel(model: PlantModelDto): Promise<void> {
    await axios.put(`${this.baseUrl}/v1/plantModel`, model, {
      headers: { 'Content-Type': 'application/json' },
    });
    this.invalidatePlantModelCache();
    this.logger.log(`Plant model "${model.name}" loaded into kernel`);
  }

  async putRawPlantModel(model: unknown): Promise<void> {
    await axios.put(`${this.baseUrl}/v1/plantModel`, model, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    this.invalidatePlantModelCache();
    this.logger.log('Plant model patched');
  }

  async getPlantModelName(): Promise<string | null> {
    const raw = await this.getRawPlantModel();
    if (!raw || typeof raw !== 'object') return null;
    const name = (raw as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }

  invalidatePlantModelCache(): void {
    this.cachedPlantModel = null;
    this.cachedPlantModelView = null;
    this.plantModelViewSource = null;
    this.plantModelFetch = null;
    this.plantModelGeneration += 1;
  }

  getRawPlantModel(): Promise<unknown> {
    if (this.cachedPlantModel) return Promise.resolve(this.cachedPlantModel);
    this.plantModelFetch ??= this.fetchRawPlantModel(this.plantModelGeneration);
    return this.plantModelFetch;
  }

  private async fetchRawPlantModel(generation: number): Promise<unknown> {
    try {
      const res = await axios.get(`${this.baseUrl}/v1/plantModel`, {
        timeout: 10_000,
      });
      if (generation === this.plantModelGeneration) {
        this.cachedPlantModel = res.data;
      }
      return res.data;
    } catch {
      return null;
    } finally {
      if (generation === this.plantModelGeneration) this.plantModelFetch = null;
    }
  }

  async getPlantModelView(): Promise<KernelPlantModel | null> {
    if (this.cachedPlantModelView) return this.cachedPlantModelView;

    const raw = await this.getRawPlantModel();
    if (this.cachedPlantModelView && this.plantModelViewSource === raw) {
      return this.cachedPlantModelView;
    }
    const view = toKernelPlantModel(raw);
    if (!view) return null;

    const unusable = unusablePlantModelEntries(raw, view);
    if (unusable.length > 0) {
      this.logger.warn(
        `Plant model: ignored ${unusable.join(', ')} the kernel reported in an unusable shape`,
      );
    }

    const aligned = alignPoints(view.points);
    for (const shift of aligned.shifts) {
      this.logger.warn(
        `Plant model: point ${describeShift(shift)} — lane and column grouping compares coordinates exactly, so WES reads the aligned value`,
      );
    }

    const alignedView = { ...view, points: aligned.points };
    if (raw === this.cachedPlantModel) {
      this.cachedPlantModelView = alignedView;
      this.plantModelViewSource = raw;
    }
    return alignedView;
  }

  async getPointNamesByLocation(): Promise<Map<string, string[]>> {
    const model = await this.getPlantModelView();
    if (!model) return new Map();
    return new Map(
      model.locations.map((location) => [
        location.name,
        locationPointNames(location.links),
      ]),
    );
  }

  async getParkingPoints(): Promise<KernelParkingPoint[]> {
    const model = await this.getPlantModelView();
    if (!model) return [];

    return model.points
      .filter((point) => point.type === 'PARK_POSITION')
      .map((point) => ({ name: point.name, priority: point.parkingPriority }));
  }

  async getChargeLocations(): Promise<KernelChargeLocation[]> {
    const model = await this.getPlantModelView();
    if (!model) return [];

    const chargeTypeNames = new Set<string>(
      model.locationTypes
        .filter((type) => type.allowedOperations.includes(this.chargeOperation))
        .map((type) => type.name),
    );

    const out: KernelChargeLocation[] = [];
    for (const loc of model.locations) {
      const typeName = loc.typeName ?? loc.type ?? '';
      if (!chargeTypeNames.has(typeName)) continue;
      const points = locationPointNames(loc.links);
      if (points.length > 0) out.push({ name: loc.name, points });
    }
    return out;
  }

  async findPickupLocationForPoint(pointName: string): Promise<string | null> {
    const model = await this.getPlantModelView();
    if (!model) return null;

    const pickupTypeNames = new Set<string>(
      model.locationTypes
        .filter((locationType) =>
          locationType.allowedOperations.includes(this.loadOperation),
        )
        .map((locationType) => locationType.name),
    );

    const pickup = model.locations.find(
      (loc) =>
        pickupTypeNames.has(loc.typeName ?? loc.type ?? '') &&
        locationPointNames(loc.links).includes(pointName),
    );
    return pickup?.name ?? null;
  }

  async hasPoint(pointName: string): Promise<boolean> {
    const model = await this.getPlantModelView();
    return model?.points.some((point) => point.name === pointName) ?? false;
  }

  async findPointForLocation(locationName: string): Promise<string | null> {
    const model = await this.getPlantModelView();
    if (!model) return null;

    const location = model.locations.find((loc) => loc.name === locationName);
    return location ? (locationPointNames(location.links)[0] ?? null) : null;
  }

  async getVehicles(): Promise<Array<KernelVehicleState>> {
    const res = await axios.get<Array<KernelVehicleState>>(
      `${this.baseUrl}/v1/vehicles`,
      { timeout: 3_000 },
    );
    return res.data;
  }

  async getVehicleEnergyThresholds(): Promise<VehicleEnergyThresholds[]> {
    const res = await axios.get<unknown[]>(`${this.baseUrl}/v1/vehicles`, {
      timeout: 5_000,
    });
    return res.data.flatMap((raw) => {
      const thresholds = toVehicleEnergyThresholds(raw);
      return thresholds ? [thresholds] : [];
    });
  }

  async setVehicleEnergyThresholds(
    thresholds: VehicleEnergyThresholds,
  ): Promise<void> {
    await axios.put(
      `${this.baseUrl}/v1/vehicles/${encodeURIComponent(thresholds.name)}/energyLevelThresholdSet`,
      {
        energyLevelCritical: thresholds.critical,
        energyLevelGood: thresholds.good,
        energyLevelSufficientlyRecharged: thresholds.sufficient,
        energyLevelFullyRecharged: thresholds.full,
      },
      { timeout: 5_000 },
    );
  }

  async getVehicleStates(): Promise<KernelVehicleState[]> {
    try {
      const res = await axios.get(`${this.baseUrl}/v1/vehicles`, {
        timeout: 5_000,
      });
      return toKernelVehicleStates(res.data);
    } catch {
      return [];
    }
  }

  async getDebugSnapshot(): Promise<unknown> {
    const [vehicles, orders] = await Promise.allSettled([
      axios.get(`${this.baseUrl}/v1/vehicles`, { timeout: 5_000 }),
      axios.get(`${this.baseUrl}/v1/transportOrders`, { timeout: 5_000 }),
    ]);

    return {
      vehicles:
        vehicles.status === 'fulfilled'
          ? toKernelVehicleStates(vehicles.value.data).map((vehicle) => ({
              name: vehicle.name,
              state: vehicle.state,
              procState: vehicle.procState,
              integrationLevel: vehicle.integrationLevel,
              currentPosition: vehicle.currentPosition,
              paused: vehicle.paused,
            }))
          : `ERROR: ${vehicles.reason}`,
      transportOrders:
        orders.status === 'fulfilled'
          ? toTransportOrderDebugList(orders.value.data)
          : `ERROR: ${orders.reason}`,
    };
  }

  async getEvents(minSequenceNo: number, timeout: number): Promise<unknown> {
    const res = await axios.get(
      `${this.baseUrl}/v1/events?minSequenceNo=${minSequenceNo}&timeout=${timeout}`,
      { timeout: timeout + 3_000 },
    );
    return res.data;
  }

  async createTransportOrder(
    name: string,
    destinations: TransportOrderDestination[],
    intendedVehicle: string | null,
    properties?: Record<string, string>,
    options: CreateTransportOrderOptions = {},
  ): Promise<KernelTransportOrderSummary> {
    const body: Record<string, unknown> = {
      destinations,
      dispensable: !!options.dispensable,
    };
    if (intendedVehicle) body.intendedVehicle = intendedVehicle;
    if (options.type) body.type = options.type;
    if (properties) {
      body.properties = Object.entries(properties).map(([key, value]) => ({
        key,
        value,
      }));
    }
    const res = await axios.post<TransportOrderResponse>(
      `${this.baseUrl}/v1/transportOrders/${encodeURIComponent(name)}`,
      body,
      { timeout: 10_000 },
    );
    this.logger.log(
      `Created TO "${name}" → ${intendedVehicle ?? 'kernel picks the vehicle'}`,
    );
    await this.triggerDispatcher();

    const created = res.data;
    return {
      name: created.name,
      state: created.state,
      destinations: created.destinations.map(
        (destination) => destination.locationName,
      ),
    };
  }

  async computeRoutes(
    vehicleName: string,
    destinationPoints: string[],
    sourcePoint?: string,
  ): Promise<KernelRoute[]> {
    const body: Record<string, unknown> = { destinationPoints };
    if (sourcePoint) body.sourcePoint = sourcePoint;
    const res = await axios.post<{ routes?: KernelRoute[] }>(
      `${this.baseUrl}/v1/vehicles/${encodeURIComponent(vehicleName)}/routeComputationQuery`,
      body,
      { timeout: 10_000 },
    );
    return res.data?.routes ?? [];
  }

  async triggerDispatcher(): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}/v1/transportOrders/dispatcher/trigger`,
        null,
        {
          timeout: 5_000,
        },
      );
    } catch {
      // non-fatal
    }
  }

  async withdrawTransportOrder(name: string, immediate = false): Promise<void> {
    await axios.post(
      `${this.baseUrl}/v1/transportOrders/${encodeURIComponent(name)}/withdrawal?immediate=${immediate}`,
      null,
      { timeout: 10_000 },
    );
  }

  async getTransportOrderState(name: string): Promise<string | null> {
    try {
      const res = await axios.get(
        `${this.baseUrl}/v1/transportOrders/${encodeURIComponent(name)}`,
        { timeout: 5_000 },
      );
      return (res.data as { state?: string })?.state ?? null;
    } catch {
      return null;
    }
  }

  async getTransportOrderStateStrict(name: string): Promise<string | null> {
    try {
      const res = await axios.get(
        `${this.baseUrl}/v1/transportOrders/${encodeURIComponent(name)}`,
        { timeout: 5_000 },
      );
      const state = (res.data as { state?: unknown })?.state;
      if (typeof state !== 'string') {
        throw new Error(`Transport order "${name}" carried no state`);
      }
      return state;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  /** Raw `GET /v1/transportOrders/{name}` — FE passthrough for the order detail dialog and the
   *  operating map's remaining-route point list. */
  async getTransportOrderRaw(name: string): Promise<unknown> {
    const res = await axios.get(
      `${this.baseUrl}/v1/transportOrders/${encodeURIComponent(name)}`,
      { timeout: 10_000 },
    );
    return res.data;
  }

  async getKernelState(): Promise<'MODELLING' | 'OPERATING' | null> {
    try {
      const res = await axios.get<{ state: string }>(
        `${this.baseUrl}/v1/kernel`,
        { timeout: 10_000 },
      );
      const s = res.data?.state;
      if (s === 'MODELLING' || s === 'OPERATING') return s;
      return null;
    } catch {
      return null;
    }
  }

  async putVehicleProperty(
    vehicleName: string,
    key: string,
    value: string | null,
  ): Promise<void> {
    await axios.put(
      `${this.baseUrl}/v1/vehicles/${encodeURIComponent(vehicleName)}/properties`,
      null,
      {
        params: value === null ? { key } : { key, newValue: value },
        timeout: 5_000,
      },
    );
  }

  async setVehicleProperty(
    vehicleName: string,
    key: string,
    value: string,
  ): Promise<void> {
    await axios.post(
      `${this.baseUrl}/v1/vehicles/${encodeURIComponent(vehicleName)}/commAdapter/message`,
      {
        type: 'tcs:virtualVehicle:setProperty',
        parameters: [
          { key: 'key', value: key },
          { key: 'value', value: value },
        ],
      },
      { timeout: 5_000 },
    );
  }

  async sendInstantAction(
    vehicleName: string,
    actionType: string,
  ): Promise<void> {
    await axios.post(
      `${this.baseUrl}/v1/vehicles/${encodeURIComponent(vehicleName)}/commAdapter/message`,
      {
        type: 'vda5050:sendInstantAction',
        parameters: [
          { key: 'actionType', value: actionType },
          { key: 'actionId', value: randomUUID() },
          { key: 'blockingType', value: 'NONE' },
        ],
      },
      { timeout: 5_000 },
    );
  }

  async setVehicleAdapterEnabled(
    vehicleName: string,
    enabled: boolean,
  ): Promise<void> {
    await this.putVehicleCommand(
      vehicleName,
      `commAdapter/enabled?newValue=${enabled}`,
      enabled ? 'kích hoạt' : 'ngừng kết nối',
    );
  }

  async setVehicleIntegrationLevel(
    vehicleName: string,
    level:
      | 'TO_BE_IGNORED'
      | 'TO_BE_NOTICED'
      | 'TO_BE_RESPECTED'
      | 'TO_BE_UTILIZED',
  ): Promise<void> {
    await this.putVehicleCommand(
      vehicleName,
      `integrationLevel?newValue=${level}`,
      'đổi mức tích hợp',
    );
  }

  async setVehiclePaused(vehicleName: string, paused: boolean): Promise<void> {
    await this.putVehicleCommand(
      vehicleName,
      `paused?newValue=${paused}`,
      paused ? 'tạm dừng' : 'tiếp tục',
    );
  }

  /** POST /v1/vehicles/{name}/withdrawal — withdraw whatever order the vehicle is running. */
  async withdrawVehicleOrder(
    vehicleName: string,
    immediate = false,
    disableVehicle = false,
  ): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}/v1/vehicles/${encodeURIComponent(vehicleName)}/withdrawal` +
          `?immediate=${immediate}&disableVehicle=${disableVehicle}`,
        null,
        { timeout: 10_000 },
      );
    } catch (err) {
      throw toVehicleCommandException(err, vehicleName, 'rút lệnh');
    }
  }

  async setPathLocked(pathName: string, locked: boolean): Promise<void> {
    await axios.put(
      `${this.baseUrl}/v1/paths/${encodeURIComponent(pathName)}/locked?newValue=${locked}`,
      null,
      { timeout: 5_000 },
    );
    this.invalidatePlantModelCache();
  }

  /**
   * Manual transport order from the operating screen. When `intendedVehicle` is omitted the
   * kernel's own dispatcher picks the vehicle — WES only pre-assigns cargo orders, so a plain
   * manual order is deliberately left for the kernel to route/assign (see report §5.4).
   */
  async createManualTransportOrder(
    destinations: TransportOrderDestination[],
    opts: { intendedVehicle?: string; type?: string } = {},
  ): Promise<{ name: string; state: string }> {
    const name = `OP-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const body: Record<string, unknown> = { destinations, dispensable: false };
    if (opts.intendedVehicle) body.intendedVehicle = opts.intendedVehicle;
    if (opts.type && opts.type !== '-') body.type = opts.type;

    const res = await axios.post<TransportOrderResponse>(
      `${this.baseUrl}/v1/transportOrders/${encodeURIComponent(name)}`,
      body,
      { timeout: 10_000 },
    );
    this.logger.log(
      `Created manual TO "${name}"` +
        (opts.intendedVehicle
          ? ` → ${opts.intendedVehicle}`
          : ' (kernel picks the vehicle)'),
    );
    await this.triggerDispatcher();
    return { name: res.data.name, state: res.data.state };
  }

  private async putVehicleCommand(
    vehicleName: string,
    pathAndQuery: string,
    action: string,
  ): Promise<void> {
    try {
      await axios.put(
        `${this.baseUrl}/v1/vehicles/${encodeURIComponent(vehicleName)}/${pathAndQuery}`,
        null,
        { timeout: 5_000 },
      );
    } catch (err) {
      throw toVehicleCommandException(err, vehicleName, action);
    }
  }

  async initializeVehiclesForOperation(): Promise<void> {
    const vehicles = await this.getVehicles().catch(
      () => [] as KernelVehicleState[],
    );
    for (const v of vehicles) {
      try {
        await this.setVehicleAdapterEnabled(v.name, true);
        await this.setVehicleIntegrationLevel(v.name, 'TO_BE_UTILIZED');
        this.logger.log(
          `Vehicle "${v.name}" → adapter enabled, TO_BE_UTILIZED`,
        );
      } catch (err) {
        this.logger.warn(
          `Could not initialize vehicle "${v.name}": ${(err as Error).message}`,
        );
      }
    }
  }

  async listEnvironmentalEntities(): Promise<unknown[]> {
    const res = await axios.get(`${this.baseUrl}/v1/environmentalEntities`, {
      timeout: ENVIRONMENTAL_ENTITY_TIMEOUT_MS,
    });
    return Array.isArray(res.data) ? (res.data as unknown[]) : [];
  }

  async getEnvironmentalEntity(name: string): Promise<unknown> {
    try {
      const res = await axios.get(
        `${this.baseUrl}/v1/environmentalEntities/${encodeURIComponent(name)}`,
        { timeout: ENVIRONMENTAL_ENTITY_TIMEOUT_MS },
      );
      return res.data as unknown;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async createEnvironmentalEntity(
    name: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await axios.post(
      `${this.baseUrl}/v1/environmentalEntities/${encodeURIComponent(name)}`,
      body,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: ENVIRONMENTAL_ENTITY_TIMEOUT_MS,
      },
    );
    return res.data as unknown;
  }

  async retireEnvironmentalEntity(
    name: string,
  ): Promise<'RETIRED' | 'MISSING'> {
    try {
      await axios.put(
        `${this.baseUrl}/v1/environmentalEntities/${encodeURIComponent(name)}/retired`,
        null,
        { timeout: ENVIRONMENTAL_ENTITY_TIMEOUT_MS },
      );
      return 'RETIRED';
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return 'MISSING';
      }
      throw err;
    }
  }

  async setKernelState(state: 'MODELLING' | 'OPERATING'): Promise<void> {
    await axios.put(`${this.baseUrl}/v1/kernel/state?newValue=${state}`, null, {
      timeout: 10_000,
    });
  }
}

export interface VehicleEnergyThresholds {
  readonly name: string;
  readonly critical: number;
  readonly good: number;
  readonly sufficient: number;
  readonly full: number;
}

function toVehicleEnergyThresholds(
  raw: unknown,
): VehicleEnergyThresholds | null {
  if (!raw || typeof raw !== 'object') return null;
  const vehicle = raw as Record<string, unknown>;
  const nested = (vehicle.energyLevelThresholdSet ?? {}) as Record<
    string,
    unknown
  >;
  const read = (key: string): number | null => {
    const value = nested[key] ?? vehicle[key];
    return typeof value === 'number' ? value : null;
  };
  const critical = read('energyLevelCritical');
  const good = read('energyLevelGood');
  const sufficient = read('energyLevelSufficientlyRecharged');
  const full = read('energyLevelFullyRecharged');
  if (
    typeof vehicle.name !== 'string' ||
    critical === null ||
    good === null ||
    sufficient === null ||
    full === null
  ) {
    return null;
  }
  return { name: vehicle.name, critical, good, sufficient, full };
}
