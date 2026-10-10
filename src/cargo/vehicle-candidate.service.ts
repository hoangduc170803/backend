import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgvEntity } from '../agvs/entities/agv.entity';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { TransportTaskEntity } from './entities/transport-task.entity';
import type { VehicleCandidate } from './domain/dispatch.policy';
import {
  isEnRouteToPark,
  isFmsDispatchable,
} from './domain/vehicle-availability';

@Injectable()
export class VehicleCandidateService {
  private readonly logger = new Logger(VehicleCandidateService.name);

  constructor(
    @InjectRepository(AgvEntity)
    private readonly agvRepo: Repository<AgvEntity>,
    private readonly vehicleStore: VehicleStateStore,
  ) {}

  async build(
    busyTasks: ReadonlyMap<string, TransportTaskEntity>,
    mapRecordId: string,
  ): Promise<VehicleCandidate[]> {
    const busy = new Set(busyTasks.keys());

    return (await this.unambiguousAgvs(mapRecordId)).map((agv) => {
      const fms = this.vehicleStore.get(agv.name);
      return {
        name: agv.name,
        dispatchEnabled: agv.isDispatchEnabled,
        ignored: agv.isIgnored,
        available: isFmsDispatchable(fms),
        preemptibleParking: isEnRouteToPark(fms),
        energyLevel: fms?.energyLevel ?? 0,
        criticalThreshold: agv.criticalBatteryThreshold,
        currentPosition: fms?.currentPosition ?? null,
        hasActiveTask: busy.has(agv.name),
      };
    });
  }

  private async unambiguousAgvs(mapRecordId: string): Promise<AgvEntity[]> {
    const agvsByName = new Map<string, AgvEntity[]>();
    for (const agv of await this.agvRepo.find({ where: { mapRecordId } })) {
      const rows = agvsByName.get(agv.name) ?? [];
      rows.push(agv);
      agvsByName.set(agv.name, rows);
    }

    const unambiguous: AgvEntity[] = [];
    for (const [name, rows] of agvsByName) {
      if (rows.length > 1) {
        this.logger.warn(
          `Duplicate AGV registry name "${name}" — excluding ${rows.length} ambiguous rows`,
        );
        continue;
      }
      unambiguous.push(rows[0]);
    }
    return unambiguous;
  }
}
