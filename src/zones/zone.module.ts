import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZoneEntity } from './entities/zone.entity';
import { ZoneMemberEntity } from './entities/zone-member.entity';
import { ZoneController } from './zone.controller';
import { ZoneService } from './zone.service';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { CargoEntity } from '../cargo/entities/cargo.entity';
import { ZoneLocationWriter } from './zone-location.writer';
import { ZoneUsageQuery } from './zone-usage.query';
import { MapRecordCoreModule } from '../maps/map-record-core.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ZoneEntity, ZoneMemberEntity, CargoEntity]),
    OpenTcsModule,
    MapRecordCoreModule,
  ],
  controllers: [ZoneController],
  providers: [ZoneService, ZoneLocationWriter, ZoneUsageQuery],
  exports: [ZoneService],
})
export class ZoneModule {}
