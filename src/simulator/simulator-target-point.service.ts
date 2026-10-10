import { BadRequestException, Injectable } from '@nestjs/common';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { ADAPTER_LOST_NAVIGATION } from '../opentcs/domain/vehicle-errors';
import type { SimulatorCommandDto } from './simulator.dto';

const MILLIMETRES_PER_METRE = 1000;

@Injectable()
export class SimulatorTargetPointService {
  constructor(private readonly kernelApi: KernelApiService) {}

  async withTargetCoordinates(
    dto: SimulatorCommandDto,
  ): Promise<SimulatorCommandDto> {
    const commandLabel = targetPointCommandLabel(dto);
    if (!commandLabel) return dto;
    if (!dto.targetNodeId) {
      throw new BadRequestException(
        `${commandLabel} cần targetNodeId — điểm xe bị đặt vào`,
      );
    }
    if (dto.x !== undefined && dto.y !== undefined) return dto;

    const plantModel = await this.kernelApi.getPlantModelView();
    const point = plantModel?.points.find(
      (candidate) => candidate.name === dto.targetNodeId,
    );
    if (!point) {
      throw new BadRequestException(
        `Không có điểm "${dto.targetNodeId}" trên bản đồ đang nạp`,
      );
    }
    return {
      ...dto,
      x: point.position.x / MILLIMETRES_PER_METRE,
      y: point.position.y / MILLIMETRES_PER_METRE,
    };
  }
}

function targetPointCommandLabel(dto: SimulatorCommandDto): string | null {
  if (dto.command === 'setPosition') return 'setPosition';
  if (
    dto.command === 'triggerError' &&
    dto.errorType === ADAPTER_LOST_NAVIGATION
  ) {
    return ADAPTER_LOST_NAVIGATION;
  }
  return null;
}
