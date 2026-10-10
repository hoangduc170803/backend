import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ORDER_KIND } from '../opentcs/domain/transport-order';
import { TransportTaskEntity } from './entities/transport-task.entity';
import { isSlotLocation, type ZoneSlotLayout } from './domain/zone-slot-layout';
import { TaskOrderService } from './task-order.service';

export type ApproachTarget =
  | { readonly locationName: string }
  | { readonly pointName: string };

export function approachTargetFor(
  layout: ZoneSlotLayout,
  target: string,
): ApproachTarget {
  return isSlotLocation(layout, target)
    ? { locationName: target }
    : { pointName: target };
}

@Injectable()
export class ApproachOrderService {
  private readonly logger = new Logger(ApproachOrderService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly transportOrders: TransportOrderService,
    private readonly taskOrders: TaskOrderService,
  ) {}

  async aim(
    task: TransportTaskEntity,
    vehicle: string,
    target: ApproachTarget,
  ): Promise<string | null> {
    const isLocation = 'locationName' in target;
    const destination = isLocation ? target.locationName : target.pointName;
    const operation = isLocation ? 'NOP' : 'MOVE';

    const persisted = await this.taskOrders.latestActiveOrder(
      task.id,
      'APPROACH',
    );
    if (
      persisted?.destinations.some(
        (item) => item.locationName === destination,
      ) ||
      task.metadata?.approachPointName === destination
    ) {
      return persisted?.orderName ?? task.metadata.approachOrderName ?? null;
    }

    const current = persisted?.orderName ?? task.metadata?.approachOrderName;
    if (current) {
      try {
        await this.transportOrders.cancel(current);
      } catch (err) {
        this.logger.error(
          `Task ${task.id}: could not withdraw ${current} before aiming at ${destination}: ${(err as Error).message}`,
        );
        return null;
      }
    }

    let orderName: string;
    try {
      orderName = await this.transportOrders.issue({
        kind: ORDER_KIND.APPROACH,
        vehicleName: vehicle,
        aimedAt: destination,
        destinations: [{ locationName: destination, operation }],
        taskId: task.id,
      });
    } catch (err) {
      this.logger.error(
        `Failed to create the approach order for task ${task.id}: ${(err as Error).message}`,
      );
      await this.forgetApproachOrder(task);
      return null;
    }

    task.metadata = {
      ...task.metadata,
      approachOrderName: orderName,
      approachPointName: destination,
      approachedAt: undefined,
    };
    await this.taskRepo.save(task);
    this.logger.log(
      `Task ${task.id}: ${vehicle} now heading to ${destination}`,
    );
    return orderName;
  }

  async cancel(task: TransportTaskEntity): Promise<void> {
    const current =
      (await this.taskOrders.latestActiveOrder(task.id, 'APPROACH'))
        ?.orderName ?? task.metadata?.approachOrderName;
    if (!current) return;

    try {
      await this.transportOrders.cancel(current);
    } catch (err) {
      this.logger.error(
        `Task ${task.id}: could not withdraw ${current} — leaving the reference so it can be retried: ${(err as Error).message}`,
      );
      return;
    }

    task.metadata = {
      ...task.metadata,
      approachOrderName: undefined,
      approachPointName: undefined,
    };
    await this.taskRepo.save(task);
  }

  private async forgetApproachOrder(task: TransportTaskEntity): Promise<void> {
    if (!task.metadata?.approachOrderName) return;

    task.metadata = {
      ...task.metadata,
      approachOrderName: undefined,
      approachPointName: undefined,
    };
    await this.taskRepo.save(task);
    this.logger.error(
      `Task ${task.id}: withdrew its approach order but could not replace it — dropped the reference so the withdrawal cannot fail the task`,
    );
  }
}
