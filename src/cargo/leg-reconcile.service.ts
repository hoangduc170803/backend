import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { TransportTaskService } from './transport-task.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  FMS_EVENTS,
  FmsTransportOrderFinishedEvent,
  TaskLeg,
} from './domain/events';
import { TaskOrderService } from './task-order.service';
import { OrderRecreationService } from './order-recreation.service';
import type { TaskOrderEntity } from './entities/task-order.entity';
import { currentLegOrder } from './domain/current-leg-order';

const LIVE_STATUSES = [TaskStatus.PICKING_UP, TaskStatus.DELIVERING];

@Injectable()
export class LegReconcileService {
  private readonly logger = new Logger(LegReconcileService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly vehicleStore: VehicleStateStore,
    private readonly kernelApi: KernelApiService,
    private readonly transportTask: TransportTaskService,
    private readonly eventEmitter: EventEmitter2,
    private readonly activeMap: ActiveMapContext,
    private readonly taskOrders: TaskOrderService,
    private readonly orderRecreation: OrderRecreationService,
  ) {}

  async run(): Promise<void> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return;
    const tasks = await this.taskRepo.find({
      where: { status: In(LIVE_STATUSES), mapRecordId },
    });
    const ordersByTask = new Map<string, TaskOrderEntity[]>();
    for (const order of await this.taskOrders.ordersOf(
      tasks.map((task) => task.id),
    )) {
      const ofTask = ordersByTask.get(order.taskId) ?? [];
      ofTask.push(order);
      ordersByTask.set(order.taskId, ofTask);
    }
    for (const task of tasks) {
      try {
        await this.reconcileTask(task, ordersByTask.get(task.id) ?? []);
      } catch (err) {
        this.logger.warn(
          `Leg reconcile failed for task ${task.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async reconcileTask(
    task: TransportTaskEntity,
    orders: readonly TaskOrderEntity[],
  ): Promise<void> {
    if (task.metadata?.replacingOrderName) return;
    const expected = this.expectedLeg(task, orders);
    if (!expected) return;

    const vehicleName = task.metadata?.assignedVehicleName;
    const onOrder = vehicleName
      ? this.vehicleStore.get(vehicleName)?.transportOrder
      : undefined;
    if (onOrder === expected.orderName) return;

    const state = await this.kernelApi.getTransportOrderState(
      expected.orderName,
    );
    if (state === 'FINISHED') {
      this.logger.warn(
        `Leg reconcile: task ${task.id} ${expected.leg} order ${expected.orderName} FINISHED but unadvanced — re-firing`,
      );
      this.eventEmitter.emit(
        FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
        new FmsTransportOrderFinishedEvent(
          expected.orderName,
          task.id,
          expected.leg,
        ),
      );
    } else if (state === 'FAILED' || state === 'UNROUTABLE') {
      const recreation = await this.orderRecreation.recreate(
        task.id,
        expected.orderName,
      );
      if (recreation !== 'not-applicable') return;
      this.logger.warn(
        `Leg reconcile: task ${task.id} ${expected.leg} order ${state} — failing task`,
      );
      await this.transportTask.changeStatus(task, TaskStatus.FAILED, {
        trigger: 'LEG_RECONCILE',
        reason: `${expected.leg} order ${state}`,
      });
    }
    // RAW/DISPATCHABLE/BEING_PROCESSED/WITHDRAWN/null → not a settled outcome
    // yet; leave the task alone and re-check next cycle.
  }

  private expectedLeg(
    task: TransportTaskEntity,
    orders: readonly TaskOrderEntity[],
  ): { leg: TaskLeg; orderName: string } | null {
    const nameOf = (leg: TaskLeg, recordedOnTask?: string): string | null =>
      orders.length > 0
        ? (currentLegOrder(orders, leg)?.orderName ?? null)
        : (recordedOnTask ?? null);
    const expect = (
      leg: TaskLeg,
      recordedOnTask?: string,
    ): { leg: TaskLeg; orderName: string } | null => {
      const orderName = nameOf(leg, recordedOnTask);
      return orderName ? { leg, orderName } : null;
    };

    const m = task.metadata;
    if (task.status === TaskStatus.PICKING_UP) {
      return expect('PICKUP', m?.pickupOrderName);
    }
    if (task.status !== TaskStatus.DELIVERING) return null;
    const dropoff = expect('DROPOFF', m?.dropoffOrderName);
    if (dropoff || m?.approachedAt) return dropoff;
    return expect('APPROACH', m?.approachOrderName);
  }
}
