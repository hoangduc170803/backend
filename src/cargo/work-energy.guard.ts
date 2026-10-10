import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgvEntity } from '../agvs/entities/agv.entity';
import { isCritical, thresholdsOf } from '../agvs/domain/battery-thresholds';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';

@Injectable()
export class WorkEnergyGuard {
  constructor(
    @InjectRepository(AgvEntity)
    private readonly agvRepo: Repository<AgvEntity>,
    private readonly vehicleStore: VehicleStateStore,
  ) {}

  async assertCanTakeNewWork(
    vehicleName: string,
    mapRecordId: string,
  ): Promise<void> {
    const agv = await this.agvRepo.findOne({
      where: { name: vehicleName, mapRecordId },
    });
    const energy = this.vehicleStore.get(vehicleName)?.energyLevel;
    if (!agv || energy === undefined) return;
    const thresholds = thresholdsOf(agv);
    if (isCritical(energy, thresholds)) {
      throw new ConflictException(
        `Xe ${vehicleName} pin ${energy}% ≤ ngưỡng nguy hiểm ${thresholds.critical}% — chỉ nhận lệnh sạc/đỗ tự động.`,
      );
    }
  }
}
