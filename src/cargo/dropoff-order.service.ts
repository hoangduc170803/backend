import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ORDER_KIND } from '../opentcs/domain/transport-order';
import type { TransportOrderDestination } from '../opentcs/domain/kernel-model';
import type { ZoneEntity } from '../zones/entities/zone.entity';
import { TransportTaskEntity } from './entities/transport-task.entity';
import { RetreatPointService } from './retreat-point.service';
import type { RetreatPlan } from './domain/retreat-point';
import { TaskOrderService } from './task-order.service';

@Injectable()
export class DropoffOrderService {
  private readonly logger = new Logger(DropoffOrderService.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly kernelApi: KernelApiService,
    private readonly transportOrders: TransportOrderService,
    private readonly retreatPoint: RetreatPointService,
    private readonly taskOrders: TaskOrderService,
  ) {}

  async issue(
    task: TransportTaskEntity,
    vehicle: string,
    slot: string,
    zone: ZoneEntity,
  ): Promise<string | null> {
    const plan = await this.retreatPoint.planFor(slot, zone);
    if (!plan) {
      this.logger.warn(
        `Task ${task.id}: no retreat point behind ${slot} — drop-off goes out without the retreat leg`,
      );
    }

    let orderName: string;
    try {
      orderName = await this.transportOrders.issue({
        kind: ORDER_KIND.DROPOFF,
        vehicleName: vehicle,
        aimedAt: slot,
        destinations: destinationsFor(
          slot,
          plan,
          this.kernelApi.unloadOperation,
        ),
        taskId: task.id,
      });
    } catch (err) {
      this.logger.error(
        `Task ${task.id}: could not create the drop-off order at ${slot}: ${(err as Error).message}`,
      );
      return null;
    }

    task.metadata = { ...task.metadata, dropoffOrderName: orderName };
    const retreatPoint = plan?.cells.at(-1);
    if (retreatPoint) task.metadata.retreatPointName = retreatPoint;
    await this.taskRepo.save(task);
    return orderName;
  }

  async cancel(task: TransportTaskEntity): Promise<void> {
    const current =
      (await this.taskOrders.latestActiveOrder(task.id, 'DROPOFF'))
        ?.orderName ?? task.metadata?.dropoffOrderName;
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
      dropoffOrderName: undefined,
      retreatPointName: undefined,
    };
    await this.taskRepo.save(task);
  }

  async reissue(
    task: TransportTaskEntity,
    vehicle: string,
    slot: string,
    zone: ZoneEntity,
  ): Promise<string | null> {
    const current =
      (await this.taskOrders.latestActiveOrder(task.id, 'DROPOFF'))
        ?.orderName ?? task.metadata?.dropoffOrderName;
    if (current) {
      try {
        await this.transportOrders.cancel(current);
      } catch (err) {
        this.logger.error(
          `Task ${task.id}: could not withdraw ${current} before aiming at ${slot}: ${(err as Error).message}`,
        );
        return null;
      }
    }
    return this.issue(task, vehicle, slot, zone);
  }
}

export function retreatDestinations(
  plan: RetreatPlan | null,
): TransportOrderDestination[] {
  const retreatCell = plan?.cells.at(-1);
  return retreatCell ? [{ locationName: retreatCell, operation: 'MOVE' }] : [];
}

function destinationsFor(
  slot: string,
  plan: RetreatPlan | null,
  unloadOperation: string,
): TransportOrderDestination[] {
  return [
    { locationName: slot, operation: unloadOperation },
    ...retreatDestinations(plan),
  ];
}
