import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ZoneEntity } from '../zones/entities/zone.entity';
import { TransportTaskEntity } from './entities/transport-task.entity';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import type { ZoneSlotLayout } from './domain/zone-slot-layout';
import {
  ApproachOrderService,
  approachTargetFor,
} from './approach-order.service';
import { DropoffOrderService } from './dropoff-order.service';
import { SlotReservationService } from './slot-reservation.service';
import { TaskOrderService } from './task-order.service';

export const DEFERRED_DROPOFF_MAX_WAIT_MS = 60_000;

export type DeferredDropoffOutcome = 'waiting' | 'issued' | 'failed';

export interface AimedVehicle {
  readonly task: TransportTaskEntity;
  readonly vehicle: string;
  readonly cargoId: string;
}

@Injectable()
export class VehicleAimService {
  private readonly logger = new Logger(VehicleAimService.name);

  constructor(
    private readonly slotReservation: SlotReservationService,
    private readonly approachOrder: ApproachOrderService,
    private readonly dropoffOrder: DropoffOrderService,
    private readonly vehicleStore: VehicleStateStore,
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly taskOrders: TaskOrderService,
  ) {}

  async queueAt(
    aimed: AimedVehicle,
    zone: ZoneEntity,
    layout: ZoneSlotLayout,
    cell: string,
  ): Promise<boolean> {
    const claimed = await this.slotReservation.claimCell(
      aimed.cargoId,
      cell,
      zone,
    );
    if (!claimed) {
      this.logger.warn(
        `Task ${aimed.task.id}: ${aimed.vehicle} cannot wait at ${cell} — another cargo holds it`,
      );
      return false;
    }

    const orderName = await this.approachOrder.aim(
      aimed.task,
      aimed.vehicle,
      approachTargetFor(layout, cell),
    );
    if (!orderName) {
      await this.slotReservation.restoreClaim(
        aimed.cargoId,
        claimed.previous,
        zone,
      );
      this.logger.error(
        `Task ${aimed.task.id}: ${aimed.vehicle} has no order for ${cell} — gave the cell back`,
      );
      return false;
    }

    return true;
  }

  async stopApproaching(aimed: AimedVehicle): Promise<void> {
    await this.approachOrder.cancel(aimed.task);
  }

  async stopDropping(aimed: AimedVehicle): Promise<void> {
    await this.dropoffOrder.cancel(aimed.task);
  }
  async dropAt(
    aimed: AimedVehicle,
    zone: ZoneEntity,
    slot: string,
    keptOwnReservation: boolean,
  ): Promise<boolean> {
    const { task, vehicle } = aimed;
    const drivenOrder = await this.orderToEndFirst(
      task,
      vehicle,
      slot,
      keptOwnReservation,
    );
    if (drivenOrder) {
      return this.handOverAfter(aimed, zone, slot, drivenOrder);
    }

    const orderName = await this.dropOffOrderFor(
      task,
      vehicle,
      zone,
      slot,
      keptOwnReservation,
    );
    if (!orderName) {
      await this.slotReservation.releaseCommit(aimed.cargoId, zone);
      this.logger.error(
        `Task ${task.id}: ${vehicle} got no drop-off order for ${slot} — released the slot so the lane stays open`,
      );
      return false;
    }

    if (this.shouldCancelApproach(task, slot)) {
      await this.approachOrder.cancel(task);
    }
    return true;
  }

  async issueDeferredDropoff(
    task: TransportTaskEntity,
    zone: ZoneEntity,
  ): Promise<DeferredDropoffOutcome> {
    const pending = task.metadata?.pendingDropoff;
    const vehicle = task.metadata?.assignedVehicleName;
    if (!pending || !vehicle || !task.cargoId) return 'failed';

    const waitedMs = Date.now() - Date.parse(pending.since);
    const stillDriving = this.isDriving(vehicle, pending.waitFor);
    if (stillDriving && waitedMs < DEFERRED_DROPOFF_MAX_WAIT_MS) {
      return 'waiting';
    }
    if (stillDriving) {
      this.logger.warn(
        `Task ${task.id}: ${vehicle} still runs ${pending.waitFor} ${Math.round(waitedMs / 1000)}s after it was withdrawn — issuing the drop-off anyway`,
      );
    }

    task.metadata = { ...task.metadata, pendingDropoff: undefined };
    const orderName = await this.dropoffOrder.issue(
      task,
      vehicle,
      pending.slot,
      zone,
    );
    if (!orderName) {
      await this.taskRepo.save(task);
      await this.slotReservation.releaseCommit(task.cargoId, zone);
      this.logger.error(
        `Task ${task.id}: ${vehicle} got no drop-off order for ${pending.slot} after ${pending.waitFor} ended — released the slot so the lane stays open`,
      );
      return 'failed';
    }
    this.logger.log(
      `Task ${task.id}: ${vehicle} finished with ${pending.waitFor} — drop-off ${orderName} for ${pending.slot} issued`,
    );
    return 'issued';
  }

  private async orderToEndFirst(
    task: TransportTaskEntity,
    vehicle: string,
    slot: string,
    keptOwnReservation: boolean,
  ): Promise<{ leg: 'APPROACH' | 'DROPOFF'; orderName: string } | null> {
    const dropoff =
      (await this.taskOrders.latestActiveOrder(task.id, 'DROPOFF'))
        ?.orderName ?? task.metadata?.dropoffOrderName;
    if (dropoff && !keptOwnReservation && this.isDriving(vehicle, dropoff)) {
      return { leg: 'DROPOFF', orderName: dropoff };
    }
    const approach =
      (await this.taskOrders.latestActiveOrder(task.id, 'APPROACH'))
        ?.orderName ?? task.metadata?.approachOrderName;
    if (
      !dropoff &&
      approach &&
      this.shouldCancelApproach(task, slot) &&
      this.isDriving(vehicle, approach)
    ) {
      return { leg: 'APPROACH', orderName: approach };
    }
    return null;
  }

  private isDriving(vehicle: string, orderName: string): boolean {
    return this.vehicleStore.get(vehicle)?.transportOrder === orderName;
  }

  private async handOverAfter(
    aimed: AimedVehicle,
    zone: ZoneEntity,
    slot: string,
    driven: { leg: 'APPROACH' | 'DROPOFF'; orderName: string },
  ): Promise<boolean> {
    const { task, vehicle } = aimed;
    if (driven.leg === 'APPROACH') {
      await this.approachOrder.cancel(task);
    } else {
      await this.dropoffOrder.cancel(task);
    }
    const stillPersisted = await this.taskOrders.latestActiveOrder(
      task.id,
      driven.leg,
    );
    const stillReferenced =
      stillPersisted?.orderName ??
      (driven.leg === 'APPROACH'
        ? task.metadata?.approachOrderName
        : task.metadata?.dropoffOrderName);
    if (stillReferenced) {
      await this.slotReservation.releaseCommit(aimed.cargoId, zone);
      this.logger.error(
        `Task ${task.id}: could not withdraw ${driven.orderName} — released ${slot} instead of sending a second order to ${vehicle}`,
      );
      return false;
    }

    task.metadata = {
      ...task.metadata,
      pendingDropoff: {
        slot,
        zoneId: zone.id,
        waitFor: driven.orderName,
        since: new Date().toISOString(),
      },
    };
    await this.taskRepo.save(task);
    this.logger.log(
      `Task ${task.id}: ${vehicle} committed ${slot} — waiting for ${driven.orderName} to end before sending the drop-off`,
    );
    return true;
  }

  private shouldCancelApproach(
    task: TransportTaskEntity,
    slot: string,
  ): boolean {
    const heading = task.metadata?.approachPointName;

    const noApproachOrderToCancel = !heading;
    if (noApproachOrderToCancel) return false;

    const alreadyHeadingToThatCell = heading === slot;
    return !alreadyHeadingToThatCell;
  }

  private async dropOffOrderFor(
    task: TransportTaskEntity,
    vehicle: string,
    zone: ZoneEntity,
    slot: string,
    keptOwnReservation: boolean,
  ): Promise<string | null> {
    const current =
      (await this.taskOrders.latestActiveOrder(task.id, 'DROPOFF'))
        ?.orderName ?? task.metadata?.dropoffOrderName;
    if (!current) return this.dropoffOrder.issue(task, vehicle, slot, zone);
    if (keptOwnReservation) return current;
    return this.dropoffOrder.reissue(task, vehicle, slot, zone);
  }
}
