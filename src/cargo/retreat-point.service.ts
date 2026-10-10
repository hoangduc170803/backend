import { laneAxisOf } from '../zones/domain/mainline';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type { ZoneEntity } from '../zones/entities/zone.entity';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import { DeliverySlotEngine } from './delivery-slot.engine';
import { pointNamesOfLocations } from './domain/zone-slot-layout';
import {
  DROPOFF_RETREAT_CELLS,
  resolveRetreatPlan,
  type RetreatPlan,
} from './domain/retreat-point';

const OCCUPYING_STATUSES = [CargoStatus.ACTIVE, CargoStatus.DELIVERED];

@Injectable()
export class RetreatPointService {
  private readonly logger = new Logger(RetreatPointService.name);

  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly deliverySlotEngine: DeliverySlotEngine,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
  ) {}

  async planFor(
    dropOffLocationName: string,
    zone: ZoneEntity,
    cells: number = DROPOFF_RETREAT_CELLS,
  ): Promise<RetreatPlan | null> {
    const dropPoint =
      await this.kernelApi.findPointForLocation(dropOffLocationName);
    if (!dropPoint) {
      this.logger.warn(
        `Drop-off "${dropOffLocationName}": no linked point — no retreat point`,
      );
      return null;
    }

    const plantModel = await this.kernelApi.getPlantModelView();
    if (!plantModel) {
      this.logger.warn(
        `Drop-off "${dropOffLocationName}": plant model unavailable — no retreat point`,
      );
      return null;
    }

    const layout = await this.deliverySlotEngine.layoutFor(zone);
    if (!layout) {
      this.logger.warn(
        `Drop-off "${dropOffLocationName}": zone "${zone.name}" has no layout — no retreat point`,
      );
      return null;
    }

    const occupied = pointNamesOfLocations(
      layout,
      await this.occupiedLocationNames(zone.id),
    );
    const plan = resolveRetreatPlan(
      plantModel,
      dropPoint,
      new Set(layout.lanes.flatMap((lane) => [...lane.axisPoints])),
      occupied,
      cells,
      laneAxisOf(
        plantModel.points,
        plantModel.paths,
        plantModel.visualLayout?.properties ?? [],
      ).axis,
    );
    if (!plan) {
      this.logger.warn(
        `Drop-off "${dropOffLocationName}" (point ${dropPoint}): no ${cells}-cell retreat with a way off the lane behind it`,
      );
      return null;
    }

    this.logger.log(
      `Drop-off "${dropOffLocationName}" (point ${dropPoint}): retreat ${plan.cells.join(' → ')}${
        plan.egress
          ? ` — still on a lane, so the next order has to route it out (nearest exit ${plan.egress})`
          : ' (already clear of every lane)'
      }`,
    );
    return plan;
  }

  private async occupiedLocationNames(zoneId: string): Promise<Set<string>> {
    const cargos = await this.cargoRepo.find({
      where: { destinationZoneId: zoneId, status: In(OCCUPYING_STATUSES) },
    });
    return cargos.reduce((names, cargo) => {
      if (cargo.destinationLocationName)
        names.add(cargo.destinationLocationName);
      return names;
    }, new Set<string>());
  }
}
