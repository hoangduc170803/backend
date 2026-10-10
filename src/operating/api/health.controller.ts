import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { VehicleStateStore } from '../../opentcs/vehicle-state.store';
import { MqttHealthService } from '../../opentcs/mqtt-health.service';
import type { OperatingHealthDto } from '../dto/operating.dto';
import { OperatingProjectionService } from '../realtime/operating-projection.service';

@ApiTags('operating')
@UseGuards(JwtAuthGuard)
@Controller('operating/health')
export class OperatingHealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly kernelApi: KernelApiService,
    private readonly vehicleStateStore: VehicleStateStore,
    private readonly mqttHealth: MqttHealthService,
    private readonly projection: OperatingProjectionService,
  ) {}

  @Get()
  async check(): Promise<OperatingHealthDto> {
    const [kernelReachable, dbOk] = await Promise.all([
      this.kernelApi.isReachable(),
      this.pingDatabase(),
    ]);

    return {
      kernel: kernelReachable ? 'ok' : 'unreachable',
      kernelSse: {
        connected: this.vehicleStateStore.isConnected(),
        ...this.vehicleStateStore.getEventStats(),
      },
      db: dbOk ? 'ok' : 'unreachable',
      mqtt: this.mqttHealth.isConnected() ? 'ok' : 'unreachable',
      realtime: this.projection.stats(),
    };
  }

  private async pingDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
