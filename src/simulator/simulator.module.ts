import { Module } from '@nestjs/common';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { SimulatorTargetPointService } from './simulator-target-point.service';
import { SimulatorController } from './simulator.controller';
import { SimulatorGatewayService } from './simulator-gateway.service';

@Module({
  imports: [OpenTcsModule],
  controllers: [SimulatorController],
  providers: [SimulatorGatewayService, SimulatorTargetPointService],
})
export class SimulatorModule {}
