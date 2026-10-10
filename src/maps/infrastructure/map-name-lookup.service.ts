import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MapRecordEntity } from './entities/map-record.entity';

/** Library map names by id — what the all-maps lists print in their "Map" column. */
@Injectable()
export class MapNameLookup {
  constructor(
    @InjectRepository(MapRecordEntity)
    private readonly maps: Repository<MapRecordEntity>,
  ) {}

  async namesOf(
    mapRecordIds: Iterable<string | null>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set([...mapRecordIds].filter((id): id is string => !!id)),
    ];
    if (ids.length === 0) return new Map();
    const rows = await this.maps.find({
      where: { id: In(ids) },
      select: { id: true, name: true },
      withDeleted: true,
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
