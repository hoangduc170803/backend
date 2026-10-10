import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransportTaskEntity } from '../cargo/entities/transport-task.entity';
import { TaskStatusTransitionEntity } from '../cargo/entities/task-status-transition.entity';
import { AgvEntity } from '../agvs/entities/agv.entity';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { MapRecordCoreModule } from '../maps/map-record-core.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TransportTaskEntity,
      TaskStatusTransitionEntity,
      AgvEntity,
    ]),
    OpenTcsModule,
    MapRecordCoreModule,
  ],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
