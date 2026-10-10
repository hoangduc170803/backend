import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CargoEntity } from './entities/cargo.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { RoutingService } from './routing.service';
import { DeliverySlotEngine } from './delivery-slot.engine';
import { shortestDistancesFrom } from './domain/routing';

export interface DispatchDistances {
  distancesTo(point: string): ReadonlyMap<string, number> | null;
  approachDistanceOf(cargo: CargoEntity): Promise<number | null>;
}

@Injectable()
export class DispatchDistanceService {
  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    private readonly routing: RoutingService,
    private readonly deliverySlotEngine: DeliverySlotEngine,
  ) {}

  async open(): Promise<DispatchDistances> {
    const graph = await this.routing.getReverseRoadGraph();
    const distanceCache = new Map<string, ReadonlyMap<string, number>>();
    const feederCache = new Map<string, readonly string[]>();

    const distancesTo = (point: string): ReadonlyMap<string, number> | null => {
      if (!graph) return null;
      const cached = distanceCache.get(point);
      if (cached) return cached;
      const computed = shortestDistancesFrom(graph, point);
      distanceCache.set(point, computed);
      return computed;
    };

    const feedersOfZone = async (
      zoneId: string,
    ): Promise<readonly string[]> => {
      const cached = feederCache.get(zoneId);
      if (cached) return cached;
      const zone = await this.zoneRepo.findOne({
        where: { id: zoneId },
        relations: { members: true },
      });
      const layout = zone
        ? await this.deliverySlotEngine.layoutFor(zone)
        : null;
      const feeders = layout?.entryPoints ?? [];
      feederCache.set(zoneId, feeders);
      return feeders;
    };

    const approachDistanceOf = async (
      cargo: CargoEntity,
    ): Promise<number | null> => {
      const sourcePoint = cargo.sourcePointName;
      if (!sourcePoint || !cargo.destinationZoneId) return null;
      const feeders = await feedersOfZone(cargo.destinationZoneId);
      let shortest: number | null = null;
      for (const feeder of feeders) {
        const distance = distancesTo(feeder)?.get(sourcePoint);
        if (
          distance === undefined ||
          !Number.isFinite(distance) ||
          distance < 0
        ) {
          continue;
        }
        if (shortest === null || distance < shortest) shortest = distance;
      }
      return shortest;
    };

    return { distancesTo, approachDistanceOf };
  }
}
