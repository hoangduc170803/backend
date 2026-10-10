import { Injectable, Logger } from '@nestjs/common';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type { KernelPlantModel } from '../opentcs/domain/kernel-model';
import type { ZoneEntity } from '../zones/entities/zone.entity';
import { laneAxisOf, type LaneAxis } from '../zones/domain/mainline';
import {
  buildZoneSlotLayout,
  laneIndexOfTarget,
  rankSlots,
  usableSlotCount,
  type ZoneSlot,
  type ZoneSlotLayout,
} from './domain/zone-slot-layout';
import { columnUpToMainline } from './domain/column-occupancy';
import { behindChain } from './domain/retreat-point';

const PLANT_MODEL_TTL_MS = 30_000;

interface CachedLayout {
  memberSignature: string;
  layout: ZoneSlotLayout;
}

@Injectable()
export class DeliverySlotEngine {
  private readonly logger = new Logger(DeliverySlotEngine.name);
  private readonly layoutByZone = new Map<string, CachedLayout>();
  private plantModel: KernelPlantModel | null = null;
  private plantModelFetchedAt = 0;
  private plantModelInFlight: Promise<KernelPlantModel | null> | null = null;
  private reportedLaneAxis: LaneAxis | null = null;

  constructor(private readonly kernelApi: KernelApiService) {}

  async layoutFor(zone: ZoneEntity): Promise<ZoneSlotLayout | null> {
    if (!zone.members || zone.members.length === 0) {
      this.logger.warn(`layoutFor: zone "${zone.name}" has no members`);
      return null;
    }

    const memberLocationNames = zone.members.map(
      (member) => member.locationName,
    );
    const memberSignature = [...memberLocationNames].sort().join('|');

    const cached = this.layoutByZone.get(zone.id);
    if (
      cached &&
      cached.memberSignature === memberSignature &&
      !this.plantModelIsStale()
    ) {
      return cached.layout;
    }

    const plantModel = await this.currentPlantModel();
    if (!plantModel) {
      this.logger.warn('layoutFor: plant model unavailable');
      return cached?.layout ?? null;
    }

    const layout = buildZoneSlotLayout(
      plantModel.points,
      plantModel.paths,
      plantModel.locations,
      memberLocationNames,
      this.laneAxisFor(plantModel),
    );
    if (layout.strandedLocationNames.length > 0) {
      this.logger.warn(
        `Zone "${zone.name}": ${layout.strandedLocationNames.length} slot(s) cannot reach the exit and are never offered: ${layout.strandedLocationNames.join(', ')}`,
      );
    }
    this.layoutByZone.set(zone.id, { memberSignature, layout });
    return layout;
  }

  rank(
    layout: ZoneSlotLayout,
    unavailableLocationNames: ReadonlySet<string>,
    activeCountByLane?: readonly number[],
  ): ZoneSlot[] {
    return rankSlots(layout, unavailableLocationNames, activeCountByLane);
  }

  async columnPointsFor(
    zone: ZoneEntity,
    target: string,
  ): Promise<ReadonlySet<string>> {
    const layout = await this.layoutFor(zone);
    if (!layout) return new Set();

    const laneIndex = laneIndexOfTarget(layout, target);
    if (laneIndex === null) return new Set();

    const shallowest = layout.lanes[laneIndex].slots.at(-1);
    const plantModel = await this.currentPlantModel();
    if (!shallowest || !plantModel) return new Set();

    return new Set(
      columnUpToMainline(
        layout.lanes[laneIndex].slots.map((slot) => slot.pointName),
        behindChain(
          plantModel,
          shallowest.pointName,
          this.laneAxisFor(plantModel),
        ),
        layout.mainlinePoints,
      ),
    );
  }

  async blockingPointsOf(zone: ZoneEntity): Promise<Set<string>> {
    const layout = await this.layoutFor(zone);
    if (!layout) return new Set();
    const points = new Set<string>(layout.memberPointNames);
    for (const lane of layout.lanes) {
      const deepest = lane.slots[0];
      if (!deepest) continue;
      for (const point of await this.columnPointsFor(
        zone,
        deepest.locationName,
      )) {
        points.add(point);
      }
    }
    return points;
  }

  capacityOf(layout: ZoneSlotLayout): number {
    return usableSlotCount(layout);
  }

  async usableCapacityOf(zone: ZoneEntity): Promise<number> {
    const layout = await this.layoutFor(zone);
    return layout ? usableSlotCount(layout) : 0;
  }

  private laneAxisFor(plantModel: KernelPlantModel): LaneAxis {
    const { axis, source } = laneAxisOf(
      plantModel.points,
      plantModel.paths,
      plantModel.visualLayout?.properties ?? [],
    );
    if (this.reportedLaneAxis !== axis) {
      this.reportedLaneAxis = axis;
      this.logger.log(
        `Lanes run along ${axis} (${source}); slot depth is measured on ${axis}, lane identity on ${axis === 'x' ? 'y' : 'x'}`,
      );
    }
    return axis;
  }

  private plantModelIsStale(): boolean {
    return Date.now() - this.plantModelFetchedAt >= PLANT_MODEL_TTL_MS;
  }

  private async currentPlantModel(): Promise<KernelPlantModel | null> {
    if (!this.plantModelIsStale() && this.plantModel) return this.plantModel;
    if (this.plantModelInFlight) return this.plantModelInFlight;

    this.plantModelInFlight = this.fetchPlantModel().finally(() => {
      this.plantModelInFlight = null;
    });
    return this.plantModelInFlight;
  }

  private async fetchPlantModel(): Promise<KernelPlantModel | null> {
    const fetched = await this.kernelApi.getPlantModelView();
    if (!fetched) return this.plantModel;

    this.plantModel = fetched;
    this.plantModelFetchedAt = Date.now();
    this.layoutByZone.clear();
    return fetched;
  }
}
