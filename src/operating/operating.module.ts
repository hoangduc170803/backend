import { Module } from '@nestjs/common';
import { MapRecordCoreModule } from '../maps/map-record-core.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { CargoModule } from '../cargo/cargo.module';
import { ZoneModule } from '../zones/zone.module';
import { UsersModule } from '../users/users.module';
import { CargoEntity } from '../cargo/entities/cargo.entity';
import { TransportTaskEntity } from '../cargo/entities/transport-task.entity';
import { TaskStatusTransitionEntity } from '../cargo/entities/task-status-transition.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { MapRecordEntity } from '../maps/infrastructure/entities/map-record.entity';
import { OperatingPlantModelService } from './application/operating-plant-model.service';
import { OperatingOrdersService } from './application/operating-orders.service';
import { OperatingVehiclesService } from './application/operating-vehicles.service';
import { OperatingCommandsService } from './application/operating-commands.service';
import { OperatingAreasService } from './application/operating-areas.service';
import { OperatingCargoService } from './application/operating-cargo.service';
import { OperatingMapSyncService } from './application/operating-map-sync.service';
import { OperatingTasksService } from './application/operating-tasks.service';
import { TaskViewAssembler } from './application/task-view.assembler';
import { TaskRegistryService } from './application/task-registry.service';
import { OperatingPlantModelController } from './api/plant-model.controller';
import { OperatingVehiclesController } from './api/vehicles.controller';
import { OperatingOrdersController } from './api/orders.controller';
import { OperatingCommandsController } from './api/commands.controller';
import { OperatingAreasController } from './api/areas.controller';
import { OperatingCargoController } from './api/cargo.controller';
import { OperatingHealthController } from './api/health.controller';
import { OperatingStreamController } from './api/stream.controller';
import { OperatingTasksController } from './api/tasks.controller';
import { TaskRegistryController } from './api/task-registry.controller';
import { TransportOrderRegistryController } from './api/transport-order-registry.controller';
import { TransportOrderRegistryService } from './application/transport-order-registry.service';
import { TaskOrderEntity } from '../cargo/entities/task-order.entity';
import { EnvironmentalEntityModule } from '../environmental-entities/environmental-entity.module';
import { OperatingProjectionService } from './realtime/operating-projection.service';
import { OperatingSummaryService } from './realtime/operating-summary.service';
import { OperatingStreamV2Controller } from './api/stream-v2.controller';
import { CargoGeneratorController } from './cargo-generator/cargo-generator.controller';
import { CargoGeneratorService } from './cargo-generator/cargo-generator.service';

@Module({
  imports: [
    OpenTcsModule,
    MapRecordCoreModule,
    CargoModule,
    ZoneModule,
    UsersModule,
    EnvironmentalEntityModule,
    TypeOrmModule.forFeature([
      CargoEntity,
      TransportTaskEntity,
      TaskStatusTransitionEntity,
      ZoneEntity,
      MapRecordEntity,
      TaskOrderEntity,
    ]),
  ],
  controllers: [
    OperatingPlantModelController,
    OperatingVehiclesController,
    OperatingOrdersController,
    OperatingCommandsController,
    OperatingAreasController,
    OperatingCargoController,
    OperatingHealthController,
    OperatingStreamController,
    OperatingStreamV2Controller,
    OperatingTasksController,
    TaskRegistryController,
    TransportOrderRegistryController,
    CargoGeneratorController,
  ],
  providers: [
    OperatingPlantModelService,
    OperatingOrdersService,
    OperatingVehiclesService,
    OperatingCommandsService,
    OperatingAreasService,
    OperatingCargoService,
    OperatingMapSyncService,
    OperatingTasksService,
    TaskViewAssembler,
    TaskRegistryService,
    TransportOrderRegistryService,
    OperatingSummaryService,
    OperatingProjectionService,
    CargoGeneratorService,
  ],
})
export class OperatingModule {}
