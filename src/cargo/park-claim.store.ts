import { OnEvent } from '@nestjs/event-emitter';
import { TASK_ORDER_EVENTS, TaskOrderReplacedEvent } from './domain/events';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { parkPointFromOrderName } from '../opentcs/domain/transport-order';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { TaskOrderService } from './task-order.service';
import type { TaskOrderEntity } from './entities/task-order.entity';

export interface ParkClaim {
  readonly point: string;
  readonly orderName: string;
}

interface LiveParkClaim extends ParkClaim {
  readonly vehicle: string;
}

const TERMINAL_PARK_ORDER_STATES: ReadonlySet<string> = new Set([
  'FINISHED',
  'FAILED',
  'UNROUTABLE',
]);

function openParkClaim(row: TaskOrderEntity): LiveParkClaim | null {
  if (row.leg !== 'PARK' || !row.vehicleName) return null;
  const point =
    row.destinations?.[0]?.locationName ??
    parkPointFromOrderName(row.orderName, row.vehicleName);
  if (!point) return null;
  return { vehicle: row.vehicleName, point, orderName: row.orderName };
}

@Injectable()
export class ParkClaimStore implements OnApplicationBootstrap {
  private readonly logger = new Logger(ParkClaimStore.name);
  private readonly claims = new Map<string, ParkClaim>();
  private ready = false;

  constructor(
    private readonly vehicleStore: VehicleStateStore,
    private readonly kernelApi: KernelApiService,
    private readonly taskOrders: TaskOrderService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.rehydrate();
  }

  claim(vehicle: string, point: string, orderName: string): void {
    this.claims.set(vehicle, { point, orderName });
  }

  @OnEvent(TASK_ORDER_EVENTS.REPLACED)
  onOrderReplaced(event: TaskOrderReplacedEvent): void {
    for (const [vehicle, claim] of this.claims) {
      if (claim.orderName === event.oldOrderName) {
        this.claims.set(vehicle, { ...claim, orderName: event.newOrderName });
      }
    }
  }

  release(vehicle: string): void {
    this.claims.delete(vehicle);
  }

  get(vehicle: string): ParkClaim | undefined {
    return this.claims.get(vehicle);
  }

  claimedPoints(): Set<string> {
    return new Set([...this.claims.values()].map((claim) => claim.point));
  }

  claimedVehicles(): Set<string> {
    return new Set(this.claims.keys());
  }

  isReady(): boolean {
    return this.ready;
  }

  async reconcile(): Promise<void> {
    if (!this.ready) {
      await this.rehydrate();
      return;
    }
    for (const [vehicle, claim] of [...this.claims]) {
      if (await this.shouldRelease(vehicle, claim)) this.release(vehicle);
    }
  }

  private async shouldRelease(
    vehicle: string,
    claim: ParkClaim,
  ): Promise<boolean> {
    const state = this.vehicleStore.get(vehicle);
    if (state?.currentPosition === claim.point) return true;
    if (state?.transportOrder === claim.orderName) return false;

    try {
      const orderState = await this.kernelApi.getTransportOrderStateStrict(
        claim.orderName,
      );
      return orderState === null || TERMINAL_PARK_ORDER_STATES.has(orderState);
    } catch (err) {
      this.logger.warn(
        `Cannot confirm ${claim.orderName} — keeping ${vehicle}'s claim on ${claim.point}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private async rehydrate(): Promise<void> {
    let orders: TaskOrderEntity[];
    try {
      const mapRecordId = await this.activeMap.id();
      orders = mapRecordId
        ? (await this.taskOrders.openOrdersOn(mapRecordId, new Date())).map(
            ({ row }) => row,
          )
        : [];
    } catch (err) {
      this.ready = false;
      this.logger.warn(
        `Park claims unreadable — no park order will be created until the order ledger can be read: ${(err as Error).message}`,
      );
      return;
    }

    this.claims.clear();
    for (const order of orders) {
      const claim = openParkClaim(order);
      if (!claim) continue;

      const superseded = this.claims.get(claim.vehicle);
      if (superseded) {
        this.logger.warn(
          `${claim.vehicle} has more than one live park order — tracking ${claim.orderName}, dropping ${superseded.orderName}`,
        );
      }
      this.claims.set(claim.vehicle, {
        point: claim.point,
        orderName: claim.orderName,
      });
    }
    this.ready = true;
    this.logger.log(
      `Park claims rehydrated: ${this.claims.size} live claim(s)`,
    );
  }
}
