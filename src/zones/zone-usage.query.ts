import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CargoEntity, CargoStatus } from '../cargo/entities/cargo.entity';

const OCCUPYING_STATUSES = [CargoStatus.ACTIVE, CargoStatus.DELIVERED];

@Injectable()
export class ZoneUsageQuery {
  constructor(
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
  ) {}

  async occupiedByZone(
    zoneIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (zoneIds.length === 0) return new Map();

    const rows = await this.cargoRepo
      .createQueryBuilder('cargo')
      .select('cargo.destinationZoneId', 'zoneId')
      .addSelect('COUNT(cargo.id)', 'count')
      .where('cargo.destinationZoneId IN (:...zoneIds)', { zoneIds })
      .andWhere('cargo.status IN (:...statuses)', {
        statuses: OCCUPYING_STATUSES,
      })
      .groupBy('cargo.destinationZoneId')
      .getRawMany<{ zoneId: string; count: string }>();

    return new Map(rows.map((row) => [row.zoneId, Number(row.count)]));
  }
}
