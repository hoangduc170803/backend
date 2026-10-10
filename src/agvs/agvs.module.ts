import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgvEntity } from './entities/agv.entity';
import { VehicleErrorEventEntity } from './entities/vehicle-error-event.entity';
import { VehicleStateTransitionEntity } from '../opentcs/entities/vehicle-state-transition.entity';
import { TransportTaskEntity } from '../cargo/entities/transport-task.entity';
import { AgvsService } from './agvs.service';
import { AgvHistoryService } from './agv-history.service';
import { VehicleErrorService } from './vehicle-error.service';
import { KernelEnergyFloorService } from './kernel-energy-floor.service';
import { AgvsController } from './agvs.controller';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { MapRecordCoreModule } from '../maps/map-record-core.module';
import { TaskOrderEntity } from '../cargo/entities/task-order.entity';
import { KernelSessionModule } from '../kernel-session/kernel-session.module';
import { AgvRestoreStep } from './agv-restore.step';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgvEntity,
      VehicleErrorEventEntity,
      VehicleStateTransitionEntity,
      TransportTaskEntity,
      TaskOrderEntity,
    ]),
    OpenTcsModule,
    MapRecordCoreModule,
    KernelSessionModule,
  ],
  providers: [
    AgvsService,
    AgvHistoryService,
    VehicleErrorService,
    KernelEnergyFloorService,
    AgvRestoreStep,
  ],
  controllers: [AgvsController],
})
export class AgvsModule {}
