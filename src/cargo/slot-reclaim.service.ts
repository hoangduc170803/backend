import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import { TransportTaskEntity } from './entities/transport-task.entity';
import { SlotReservationService } from './slot-reservation.service';
import {
  TRANSPORT_TASK_EVENTS,
  TransportTaskFailedEvent,
} from './domain/events';
import { willNeverDropThere } from './domain/slot-reclaim.policy';
import { latestTaskByCargoId } from './task-queries';
import { TaskOrderService } from './task-order.service';

const SWEEP_MS = 30_000;

@Injectable()
export class SlotReclaimService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlotReclaimService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly slotReservation: SlotReservationService,
    private readonly transportOrders: TransportOrderService,
    private readonly activeMap: ActiveMapContext,
    private readonly taskOrders: TaskOrderService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  @OnEvent(TRANSPORT_TASK_EVENTS.FAILED)
  async onTaskFailed(event: TransportTaskFailedEvent): Promise<void> {
    if (!event.cargoId) return;

    const latest =
      (await latestTaskByCargoId(this.taskRepo, [event.cargoId])).get(
        event.cargoId,
      ) ?? null;
    if (latest && latest.id !== event.taskId) return;

    await this.reclaimOne(event.cargoId, latest);
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const abandoned = await this.abandonedCommits();
      for (const { cargoId, task } of abandoned) {
        await this.reclaimOne(cargoId, task);
      }
    } catch (err) {
      this.logger.error(
        `Could not sweep abandoned drop-off slots: ${(err as Error).message}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  private async reclaimOne(
    cargoId: string,
    task: TransportTaskEntity | null,
  ): Promise<void> {
    try {
      await this.reclaim(cargoId, task);
    } catch (err) {
      this.logger.error(
        `Cargo ${cargoId}: could not take its drop-off slot back: ${(err as Error).message}`,
      );
    }
  }

  private async abandonedCommits(): Promise<
    { cargoId: string; task: TransportTaskEntity | null }[]
  > {
    const committed = await this.cargoRepo.find({
      where: [
        {
          status: CargoStatus.ACTIVE,
          destinationLocationName: Not(IsNull()),
        },
        {
          status: CargoStatus.ACTIVE,
          reservedLocationName: Not(IsNull()),
        },
      ],
    });
    if (committed.length === 0) return [];

    const taskByCargoId = await latestTaskByCargoId(
      this.taskRepo,
      committed.map((cargo) => cargo.id),
    );

    return committed.flatMap((cargo) => {
      const task = taskByCargoId.get(cargo.id) ?? null;
      return willNeverDropThere(task?.status ?? null)
        ? [{ cargoId: cargo.id, task }]
        : [];
    });
  }

  private async reclaim(
    cargoId: string,
    task: TransportTaskEntity | null,
  ): Promise<void> {
    const cargo = await this.cargoRepo.findOne({ where: { id: cargoId } });
    const slot =
      cargo?.destinationLocationName ?? cargo?.reservedLocationName ?? null;
    if (!cargo || !slot || !cargo.destinationZoneId) return;

    const zone = await this.zoneRepo.findOne({
      where: { id: cargo.destinationZoneId },
    });
    if (!zone) return;

    await this.stopDrivingThere(task);
    if (cargo.destinationLocationName) {
      await this.slotReservation.releaseCommit(cargoId, zone);
    } else {
      await this.slotReservation.release(cargoId, zone.id);
    }
    this.logger.warn(
      `Cargo ${cargoId}: took ${slot} back in zone "${zone.name}" — ${describeHolder(task)} will never drop there`,
    );
  }

  /** Only the loaded map's kernel runs this task's orders — a task of another map has none there. */
  private async stopDrivingThere(
    task: TransportTaskEntity | null,
  ): Promise<void> {
    if (!task || task.mapRecordId !== (await this.activeMap.id())) return;
    const persisted = await this.taskOrders.activeOrderNames(task.id);
    const orderNames = new Set([
      ...persisted,
      ...[
        task.metadata?.approachOrderName,
        task.metadata?.dropoffOrderName,
      ].filter((name): name is string => !!name),
    ]);
    for (const orderName of orderNames) {
      try {
        await this.transportOrders.cancel(orderName);
      } catch (err) {
        this.logger.warn(
          `Could not cancel ${orderName} before taking its slot back: ${(err as Error).message}`,
        );
      }
    }
  }
}

function describeHolder(task: TransportTaskEntity | null): string {
  if (!task) return 'a task that no longer exists';
  const vehicle = task.metadata?.assignedVehicleName;
  return vehicle
    ? `${vehicle} on ${task.status} task ${task.id}`
    : `${task.status} task ${task.id}`;
}
