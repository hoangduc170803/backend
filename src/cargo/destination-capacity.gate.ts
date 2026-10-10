import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { CargoEntity } from './entities/cargo.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { SlotReservationService } from './slot-reservation.service';

const PROBE_HEADROOM = 20;

export interface DestinationRound {
  admit(cargo: CargoEntity): Promise<boolean>;
}

@Injectable()
export class DestinationCapacityGate {
  private readonly logger = new Logger(DestinationCapacityGate.name);

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly slotReservation: SlotReservationService,
  ) {}

  async openRound(mapRecordId: string): Promise<DestinationRound> {
    const heading = await this.cargosHeadingWithoutSlot(mapRecordId);
    const remainingByZone = new Map<string, number>();

    const remainingFor = async (zoneId: string): Promise<number> => {
      const known = remainingByZone.get(zoneId);
      if (known !== undefined) return known;
      const zone = await this.zoneRepo.findOne({
        where: { id: zoneId },
        relations: { members: true },
      });
      const demand = heading.get(zoneId) ?? 0;
      const queueable = zone
        ? await this.slotReservation.queueableSlots(
            zone,
            demand + PROBE_HEADROOM,
          )
        : 0;
      const remaining = queueable - demand;
      remainingByZone.set(zoneId, remaining);
      if (remaining <= 0) {
        this.logger.debug(
          `Zone "${zone?.name ?? zoneId}": ${queueable} slot(s) can still be reserved, ${demand} loaded/assigned vehicle(s) already need one — holding new pick-ups for it`,
        );
      }
      return remaining;
    };

    return {
      admit: async (cargo) => {
        const zoneId = cargo.destinationZoneId;
        if (!zoneId) return true;
        const remaining = await remainingFor(zoneId);
        if (remaining <= 0) return false;
        remainingByZone.set(zoneId, remaining - 1);
        return true;
      },
    };
  }

  private async cargosHeadingWithoutSlot(
    mapRecordId: string,
  ): Promise<Map<string, number>> {
    const tasks = await this.taskRepo.find({
      where: {
        kind: TaskKind.CARGO,
        status: TaskStatus.PICKING_UP,
        mapRecordId,
      },
    });
    const cargoIds = tasks.flatMap((task) =>
      task.cargoId ? [task.cargoId] : [],
    );
    if (cargoIds.length === 0) return new Map();
    const cargos = await this.cargoRepo.find({
      where: {
        id: In(cargoIds),
        reservedLocationName: IsNull(),
        destinationLocationName: IsNull(),
      },
    });
    const byZone = new Map<string, number>();
    for (const cargo of cargos) {
      if (!cargo.destinationZoneId) continue;
      byZone.set(
        cargo.destinationZoneId,
        (byZone.get(cargo.destinationZoneId) ?? 0) + 1,
      );
    }
    return byZone;
  }
}
