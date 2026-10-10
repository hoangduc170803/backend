import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlantModelWriter } from '../opentcs/plant-model-writer.service';
import {
  withMemberLocations,
  withoutLocations,
  type KernelLocationType,
  type MemberLocationSpec,
} from '../opentcs/plant-model-locations';
import { ZoneEntity, ZoneType } from './entities/zone.entity';
import { ZoneMemberEntity } from './entities/zone-member.entity';
import { pointNameOf } from './domain/location-naming';

@Injectable()
export class ZoneLocationWriter {
  private readonly logger = new Logger(ZoneLocationWriter.name);

  constructor(
    private readonly plantModelWriter: PlantModelWriter,
    @InjectRepository(ZoneMemberEntity)
    private readonly memberRepo: Repository<ZoneMemberEntity>,
  ) {}

  kernelTypeOf(zoneType: ZoneType): KernelLocationType {
    return zoneType === ZoneType.DROPOFF ? 'Drop off' : 'Pick up';
  }

  specsFor(
    memberLocationNames: readonly string[],
    type: KernelLocationType,
  ): MemberLocationSpec[] {
    return memberLocationNames.map((locationName) => ({
      locationName,
      pointName: pointNameOf(locationName),
      type,
    }));
  }

  async write(specs: readonly MemberLocationSpec[]): Promise<void> {
    if (specs.length === 0) return;
    await this.plantModelWriter.update(
      (rawModel) => withMemberLocations(rawModel, specs),
      {
        reason: `zone locations written (${specs.length})`,
        vehicles: 'restore',
      },
    );
    this.logger.log(`Wrote ${specs.length} zone location(s) to the kernel`);
  }

  async removeUnshared(zone: ZoneEntity): Promise<void> {
    const memberLocationNames = [
      ...new Set(zone.members.map((member) => member.locationName)),
    ];
    if (memberLocationNames.length === 0) return;

    const shared = await this.sharedWithOtherZones(zone, memberLocationNames);
    const removable = memberLocationNames.filter((name) => !shared.has(name));
    if (removable.length === 0) return;

    await this.plantModelWriter.update(
      (rawModel) => withoutLocations(rawModel, removable),
      { reason: `zone "${zone.name}" locations removed`, vehicles: 'restore' },
    );
    this.logger.log(
      `Zone "${zone.name}" (${zone.id}): removed ${removable.length} location(s) from the kernel`,
    );
  }

  /**
   * Location names another zone of the SAME map still uses. Zones copied to another map keep the
   * same names, and those live in a different plant model — counting them would leave this map's
   * locations on the kernel forever after the zone is deleted.
   */
  private async sharedWithOtherZones(
    zone: ZoneEntity,
    memberLocationNames: readonly string[],
  ): Promise<Set<string>> {
    const builder = this.memberRepo
      .createQueryBuilder('member')
      .select('member.locationName', 'locationName')
      .innerJoin(ZoneEntity, 'zone', 'zone.id = member.zoneId')
      .where('member.zoneId != :zoneId', { zoneId: zone.id });
    if (zone.mapRecordId) {
      builder.andWhere('zone.mapRecordId = :mapRecordId', {
        mapRecordId: zone.mapRecordId,
      });
    } else {
      builder.andWhere('zone.mapRecordId IS NULL');
    }
    const rows = await builder
      .andWhere('member.locationName IN (:...names)', {
        names: memberLocationNames,
      })
      .andWhere('zone.deletedAt IS NULL')
      .distinct(true)
      .getRawMany<{ locationName: string }>();

    return new Set(rows.map((row) => row.locationName));
  }
}
