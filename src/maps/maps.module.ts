import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MapRecordEntity } from './infrastructure/entities/map-record.entity';
import { MapLibraryService } from './application/map-library.service';
import { KernelMapService } from './application/kernel-map.service';
import { MapsController } from './api/maps.controller';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { CargoEntity } from '../cargo/entities/cargo.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { ZoneModule } from '../zones/zone.module';
import { MapRecordCoreModule } from './map-record-core.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MapRecordEntity, CargoEntity, ZoneEntity]),
    OpenTcsModule,
    ZoneModule,
    MapRecordCoreModule,
  ],
  providers: [MapLibraryService, KernelMapService],
  controllers: [MapsController],
})
export class MapsModule {}
