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
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';

import { TaskCancellationService } from './task-cancellation.service';
import { CargoEntity } from './entities/cargo.entity';
import { CargoService } from './cargo.service';
import type { StatusChangeLog } from './transport-task.service';
import { TaskOrderService } from './task-order.service';
import { KernelSessionService } from '../kernel-session/kernel-session.service';

export const DISCONNECT_GRACE_MS = 3_000;
export const AUTO_IGNORED_PROPERTY = 'wes:autoIgnoredDisconnect';
const CHECK_INTERVAL_MS = 500;

export function isLostConnection(state: KernelVehicleState): boolean {
  return (
    state.state === 'UNKNOWN' && state.integrationLevel === 'TO_BE_UTILIZED'
  );
}

export function wasAutoIgnored(state: KernelVehicleState): boolean {
  return state.properties?.[AUTO_IGNORED_PROPERTY] === 'true';
}

@Injectable()
export class VehicleDisconnectWatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VehicleDisconnectWatcher.name);
  private readonly lostSince = new Map<string, number>();
  private readonly busy = new Set<string>();
  private subscription: Subscription | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly vehicleStore: VehicleStateStore,
    private readonly kernelApi: KernelApiService,
    private readonly activeMap: ActiveMapContext,
    private readonly cancellation: TaskCancellationService,
    private readonly cargo: CargoService,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    private readonly taskOrders: TaskOrderService,
    private readonly kernelSession: KernelSessionService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.vehicleStore.vehicleUpdates.subscribe((state) =>
      this.observe(state, Date.now()),
    );
    this.timer = setInterval(
      () => void this.tick(Date.now()),
      CHECK_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
  }

  observe(state: KernelVehicleState, now: number): void {
    if (!this.kernelSession.isReady()) {
      this.lostSince.clear();
      return;
    }
    if (isLostConnection(state)) {
      if (!this.lostSince.has(state.name)) this.lostSince.set(state.name, now);
      return;
    }
    this.lostSince.delete(state.name);
    if (state.state !== 'UNKNOWN' && wasAutoIgnored(state)) {
      void this.guarded(state.name, () => this.restore(state.name));
    }
  }

  async tick(now: number): Promise<void> {
    if (!this.kernelSession.isReady()) {
      this.lostSince.clear();
      return;
    }
    for (const [name, since] of [...this.lostSince]) {
      if (now - since < DISCONNECT_GRACE_MS) continue;
      this.lostSince.delete(name);
      const handled = await this.guarded(name, () => this.handleLost(name));
      const stillLost = this.vehicleStore.get(name);
      if (!handled && stillLost && isLostConnection(stillLost)) {
        this.lostSince.set(name, now);
      }
    }
  }

  async releaseVehicleWork(
    vehicleName: string,
    reason: string,
    trigger: StatusChangeLog['trigger'],
  ): Promise<void> {
    const log: StatusChangeLog = { trigger, reason, vehicleName };
    const mapRecordId = await this.activeMap.id();
    const task = mapRecordId
      ? await this.cancellation.activeTaskOf(vehicleName, mapRecordId)
      : null;

    if (task && (await this.loadMayBeOnBoard(task))) {
      await this.cargo.failCargo(task.cargoId!, reason, log);
      this.logger.warn(
        `${vehicleName}: cargo of ${task.requestCode} failed — ${reason}`,
      );
      return;
    }
    if (task) {
      const { results } = await this.cancellation.cancelTasks([task.id], {
        permissions: { cargo: true, direct: true },
        log,
        loadConfirmedOffBoard: true,
      });
      this.logger.warn(
        `${vehicleName}: task ${task.requestCode} ${results[0]?.outcome} — ${reason}`,
      );
      return;
    }
    if (this.vehicleStore.get(vehicleName)?.transportOrder) {
      await this.kernelApi.withdrawVehicleOrder(vehicleName, true);
    }
  }

  private async loadMayBeOnBoard(task: TransportTaskEntity): Promise<boolean> {
    if (task.kind !== TaskKind.CARGO || !task.cargoId) return false;
    if (task.status === TaskStatus.DELIVERING) return true;
    if (task.status !== TaskStatus.PICKING_UP) return false;
    const vehicle = task.metadata?.assignedVehicleName
      ? this.vehicleStore.get(task.metadata.assignedVehicleName)
      : undefined;
    if (vehicle?.loaded === true) return true;
    if (
      await this.standsOnPickupPoint(task.cargoId, vehicle?.currentPosition)
    ) {
      return true;
    }
    const pickupOrderName =
      (await this.taskOrders.latestOrder(task.id, 'PICKUP'))?.orderName ??
      task.metadata?.pickupOrderName;
    return this.pickupReportedDone(pickupOrderName);
  }

  private async standsOnPickupPoint(
    cargoId: string,
    position: string | null | undefined,
  ): Promise<boolean> {
    if (!position) return false;
    const cargo = await this.cargoRepo.findOne({ where: { id: cargoId } });
    return cargo?.sourcePointName === position;
  }

  private async pickupReportedDone(
    pickupOrderName: string | undefined,
  ): Promise<boolean> {
    if (!pickupOrderName) return false;
    const order = (await this.kernelApi
      .getTransportOrderRaw(pickupOrderName)
      .catch(() => null)) as {
      state?: string;
      destinations?: { state?: string }[];
    } | null;
    return (
      order?.state === 'FINISHED' ||
      (order?.destinations ?? []).some(
        (destination) => destination.state === 'FINISHED',
      )
    );
  }

  private async handleLost(vehicleName: string): Promise<void> {
    const reason = `Xe ${vehicleName} mất kết nối`;
    this.logger.warn(
      `${reason} quá ${DISCONNECT_GRACE_MS}ms — giải phóng việc và ignore xe`,
    );
    await this.releaseVehicleWork(vehicleName, reason, 'DISCONNECT_WATCHER');
    if (this.vehicleStore.get(vehicleName)?.transportOrder) {
      await this.kernelApi.withdrawVehicleOrder(vehicleName, true);
    }
    await this.kernelApi.setVehicleIntegrationLevel(
      vehicleName,
      'TO_BE_IGNORED',
    );
    await this.kernelApi.putVehicleProperty(
      vehicleName,
      AUTO_IGNORED_PROPERTY,
      'true',
    );
  }

  private async restore(vehicleName: string): Promise<void> {
    await this.kernelApi.setVehicleIntegrationLevel(
      vehicleName,
      'TO_BE_UTILIZED',
    );
    await this.kernelApi.putVehicleProperty(
      vehicleName,
      AUTO_IGNORED_PROPERTY,
      null,
    );
    this.logger.log(`${vehicleName} kết nối lại — đưa lại vào vận hành`);
  }

  private async guarded(
    vehicleName: string,
    action: () => Promise<void>,
  ): Promise<boolean> {
    if (this.busy.has(vehicleName)) return true;
    this.busy.add(vehicleName);
    try {
      await action();
      return true;
    } catch (err) {
      this.logger.error(
        `${vehicleName}: disconnect handling failed, retrying — ${(err as Error).message}`,
      );
      return false;
    } finally {
      this.busy.delete(vehicleName);
    }
  }
}
