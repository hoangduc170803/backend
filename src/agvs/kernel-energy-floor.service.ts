import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  KernelApiService,
  type VehicleEnergyThresholds,
} from '../opentcs/kernel-api.service';
import { FMS_EVENTS } from '../cargo/domain/events';

export const DEFAULT_KERNEL_ENERGY_CRITICAL_FLOOR = 5;
const RECONCILE_EVERY_MS = 60_000;

export function withCriticalFloor(
  current: VehicleEnergyThresholds,
  floor: number,
): VehicleEnergyThresholds | null {
  if (current.critical === floor) return null;
  return {
    ...current,
    critical: floor,
    good: Math.max(current.good, floor),
  };
}

function floorFromEnv(): number {
  const parsed = Number(process.env.KERNEL_ENERGY_CRITICAL_FLOOR);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : DEFAULT_KERNEL_ENERGY_CRITICAL_FLOOR;
}

@Injectable()
export class KernelEnergyFloorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(KernelEnergyFloorService.name);
  private readonly floor = floorFromEnv();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly kernelApi: KernelApiService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_EVERY_MS);
    void this.reconcile();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  @OnEvent(FMS_EVENTS.KERNEL_CONNECTED)
  @OnEvent(FMS_EVENTS.MAP_LOADED)
  @OnEvent(FMS_EVENTS.PLANT_MODEL_REPLACED)
  onKernelModelChanged(): void {
    void this.reconcile();
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const vehicles = await this.kernelApi.getVehicleEnergyThresholds();
      for (const vehicle of vehicles) {
        const next = withCriticalFloor(vehicle, this.floor);
        if (next) await this.apply(vehicle, next);
      }
    } catch (err) {
      this.logger.debug(
        `Kernel energy floor not reconciled: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async apply(
    current: VehicleEnergyThresholds,
    next: VehicleEnergyThresholds,
  ): Promise<void> {
    try {
      await this.kernelApi.setVehicleEnergyThresholds(next);
      this.logger.log(
        `${current.name}: kernel energy critical ${current.critical}% → ${next.critical}% (WES decides charging above it)`,
      );
    } catch (err) {
      this.logger.warn(
        `${current.name}: could not set kernel energy critical to ${next.critical}% — ${(err as Error).message}`,
      );
    }
  }
}
