import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { MapRecordCoreModule } from '../maps/map-record-core.module';
import { CargoEntity } from '../cargo/entities/cargo.entity';
import { TransportTaskEntity } from '../cargo/entities/transport-task.entity';
import { MapRecordEntity } from '../maps/infrastructure/entities/map-record.entity';
import { CargoEnvironmentalEntity } from './entities/cargo-environmental-entity.entity';
import { CargoEnvironmentalEntityLog } from './entities/cargo-environmental-entity-log.entity';
import { EnvironmentalEntitySyncService } from './environmental-entity-sync.service';
import { EnvironmentalEntityController } from './environmental-entity.controller';
import { EnvironmentalEntityAdminService } from './environmental-entity-admin.service';
import { EntitySyncStore, TypeOrmEntitySyncStore } from './entity-sync.store';
import { EntitySyncLock, PgAdvisoryEntitySyncLock } from './entity-sync.lock';
import { EnvironmentalEntityRestoreStep } from './environmental-entity-restore.step';
import { KernelSessionModule } from '../kernel-session/kernel-session.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CargoEnvironmentalEntity,
      CargoEnvironmentalEntityLog,
      CargoEntity,
      TransportTaskEntity,
      MapRecordEntity,
    ]),
    OpenTcsModule,
    MapRecordCoreModule,
    KernelSessionModule,
  ],
  providers: [
    EnvironmentalEntitySyncService,
    EnvironmentalEntityAdminService,
    EnvironmentalEntityRestoreStep,
    { provide: EntitySyncStore, useClass: TypeOrmEntitySyncStore },
    { provide: EntitySyncLock, useClass: PgAdvisoryEntitySyncLock },
  ],
  controllers: [EnvironmentalEntityController],
  exports: [EnvironmentalEntitySyncService, EnvironmentalEntityAdminService],
})
export class EnvironmentalEntityModule {}
