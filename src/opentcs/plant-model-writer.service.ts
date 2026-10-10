import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KernelApiService } from './kernel-api.service';
import type { KernelVehicleState } from './domain/kernel-model';
import { savePlantModel } from './save-plant-model';
import { FMS_EVENTS, FmsPlantModelReplacedEvent } from '../cargo/domain/events';

export type PlantModelVehiclePolicy = 'initialize' | 'restore';

export interface PlantModelWriteOptions {
  reason: string;
  vehicles: PlantModelVehiclePolicy;
  afterWrite?: () => Promise<void>;
}

@Injectable()
export class PlantModelWriter {
  private readonly logger = new Logger(PlantModelWriter.name);
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  replace(model: unknown, options: PlantModelWriteOptions): Promise<void> {
    return this.exclusive(() => this.write(model, options));
  }

  update(
    mutate: (rawModel: Record<string, unknown>) => unknown,
    options: PlantModelWriteOptions,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      this.kernelApi.invalidatePlantModelCache();
      const rawModel = await this.kernelApi.getRawPlantModel();
      if (!rawModel || typeof rawModel !== 'object') {
        throw new ServiceUnavailableException(
          'Không thể kết nối hệ thống điều khiển.',
        );
      }
      const next = mutate(rawModel as Record<string, unknown>);
      if (next === null) return false;
      await this.write(next, options);
      return true;
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(
    model: unknown,
    options: PlantModelWriteOptions,
  ): Promise<void> {
    const priorVehicles =
      options.vehicles === 'restore' ? await this.snapshotVehicles() : [];

    await this.notify(
      FMS_EVENTS.PLANT_MODEL_REPLACING,
      new FmsPlantModelReplacedEvent(options.reason),
    );
    let succeeded = false;
    try {
      await savePlantModel(this.kernelApi, model);
      this.logger.log(`Plant model written to the kernel (${options.reason})`);

      await options.afterWrite?.();

      if (options.vehicles === 'initialize') {
        await this.kernelApi.initializeVehiclesForOperation();
      } else {
        await this.restoreVehicles(priorVehicles);
      }
      succeeded = true;
    } finally {
      await this.notify(
        FMS_EVENTS.PLANT_MODEL_REPLACED,
        new FmsPlantModelReplacedEvent(options.reason, succeeded),
      );
    }
  }

  private async notify(
    event: string,
    payload: FmsPlantModelReplacedEvent,
  ): Promise<void> {
    try {
      await this.eventEmitter.emitAsync(event, payload);
    } catch (err) {
      this.logger.warn(
        `Listeners of ${event} failed after "${payload.reason}": ${(err as Error).message}`,
      );
    }
  }

  private async snapshotVehicles(): Promise<KernelVehicleState[]> {
    try {
      return await this.kernelApi.getVehicleStates();
    } catch {
      return [];
    }
  }

  private async restoreVehicles(prior: KernelVehicleState[]): Promise<void> {
    for (const v of prior) {
      if (v.state === 'UNKNOWN') continue;
      try {
        await this.kernelApi.setVehicleAdapterEnabled(v.name, true);
        await this.kernelApi.setVehicleIntegrationLevel(
          v.name,
          v.integrationLevel,
        );
      } catch (err) {
        this.logger.warn(
          `Could not restore vehicle "${v.name}" after plant model write: ${(err as Error).message}`,
        );
      }
    }
  }
}
