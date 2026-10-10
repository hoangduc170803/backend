import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CargoModule } from '../cargo/cargo.module';
import { MapRecordCoreModule } from '../maps/map-record-core.module';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { LegacyFmsCargoController } from './legacy-fms-cargo.controller';
import { LegacyFmsCargoService } from './legacy-fms-cargo.service';

@Module({
  imports: [
    CargoModule,
    MapRecordCoreModule,
    TypeOrmModule.forFeature([ZoneEntity]),
  ],
  controllers: [LegacyFmsCargoController],
  providers: [LegacyFmsCargoService],
})
export class LegacyFmsApiModule {}
