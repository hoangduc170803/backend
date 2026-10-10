import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Subscription } from 'rxjs';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { KernelSessionService } from '../kernel-session/kernel-session.service';
import type {
  KernelRestoreContext,
  KernelRestoreStep,
} from '../kernel-session/domain/kernel-session';
import { AgvEntity } from './entities/agv.entity';

export class KernelVehiclesUnavailable extends Error {}

export function integrationLevelOf(
  agv: Pick<AgvEntity, 'isIgnored'>,
): 'TO_BE_RESPECTED' | 'TO_BE_UTILIZED' {
  return agv.isIgnored ? 'TO_BE_RESPECTED' : 'TO_BE_UTILIZED';
}

export function vehiclesToRestore(
  agvs: readonly AgvEntity[],
  kernelNames: ReadonlySet<string>,
  connectedBeforeReset: ReadonlySet<string> | null,
): AgvEntity[] {
  return agvs.filter(
    (agv) =>
      kernelNames.has(agv.name) &&
      (connectedBeforeReset
        ? connectedBeforeReset.has(agv.name)
        : !agv.isIgnored),
  );
}

@Injectable()
export class AgvRestoreStep
  implements OnModuleInit, OnModuleDestroy, KernelRestoreStep
{
  readonly name = 'Khôi phục xe';
  readonly order = 20;
  private readonly logger = new Logger(AgvRestoreStep.name);
  private readonly connected = new Set<string>();
  private observedWhileReady = false;
  private subscription: Subscription | null = null;

  constructor(
    @InjectRepository(AgvEntity)
    private readonly repo: Repository<AgvEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly vehicleStore: VehicleStateStore,
    private readonly session: KernelSessionService,
  ) {}

  onModuleInit(): void {
    this.session.registerStep(this);
    this.subscription = this.vehicleStore.vehicleUpdates.subscribe((state) =>
      this.observe(state),
    );
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  observe(state: KernelVehicleState): void {
    if (!this.session.isReady()) return;
    this.observedWhileReady = true;
    if (state.state === 'UNKNOWN') this.connected.delete(state.name);
    else this.connected.add(state.name);
  }

  async run(context: KernelRestoreContext): Promise<void> {
    let kernelNames: Set<string>;
    try {
      kernelNames = new Set(
        (await this.kernelApi.getVehicles()).map((vehicle) => vehicle.name),
      );
    } catch (err) {
      throw new KernelVehiclesUnavailable((err as Error).message);
    }
    const agvs = await this.repo.find({
      where: { mapRecordId: context.mapRecordId },
    });
    const snapshot = this.observedWhileReady ? this.connected : null;
    if (!snapshot) {
      this.logger.warn(
        'No record of which vehicles were connected before the reset — reconnecting every AGV that is not ignored',
      );
    }
    for (const agv of vehiclesToRestore(agvs, kernelNames, snapshot)) {
      try {
        await this.kernelApi.setVehicleAdapterEnabled(agv.name, true);
        await this.kernelApi.setVehicleIntegrationLevel(
          agv.name,
          integrationLevelOf(agv),
        );
      } catch (err) {
        this.logger.warn(
          `Could not restore ${agv.name} after the kernel reset: ${(err as Error).message}`,
        );
      }
    }
  }
}
