import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { MapRecordEntity } from './entities/map-record.entity';
import { parseOpenTcsXml } from '../../opentcs/map-loader/opentcs-xml.parser';
import { topologyFingerprint } from '../domain/topology-fingerprint';

/**
 * Resolves the `map_records` row that is actually loaded into the kernel right now — the
 * single source of truth for "which map is active", used both to stamp new Zones/Areas with
 * their owning record and to mark a library card `active` in the UI.
 *
 * The last successful WES load supplies the candidate record. Its original XML routing
 * graph must match a fresh kernel snapshot; names alone never establish identity.
 *
 * A kernel that cannot be reached proves nothing either way: the last map WES loaded stays the
 * answer, so everything WES keeps in its own database remains readable while the kernel is down.
 */
@Injectable()
export class ActiveMapRecordService {
  constructor(
    @InjectRepository(MapRecordEntity)
    private readonly repo: Repository<MapRecordEntity>,
    private readonly kernelApi: KernelApiService,
  ) {}

  async resolve(): Promise<MapRecordEntity | null> {
    // KernelApi otherwise caches indefinitely. External FMS loads must be observed.
    this.kernelApi.invalidatePlantModelCache();
    const [mostRecentlyLoaded, currentModel] = await Promise.all([
      this.repo
        .createQueryBuilder('record')
        .addSelect('record.xmlContent')
        .orderBy('record.last_loaded_at', 'DESC', 'NULLS LAST')
        .limit(1)
        .getOne(),
      this.kernelApi.getRawPlantModel(),
    ]);

    if (!mostRecentlyLoaded?.lastLoadedAt) return null;
    if (!currentModel) return mostRecentlyLoaded;
    if (!mostRecentlyLoaded.xmlContent) return null;
    try {
      const expected = topologyFingerprint(
        parseOpenTcsXml(mostRecentlyLoaded.xmlContent),
      );
      return expected && expected === topologyFingerprint(currentModel)
        ? mostRecentlyLoaded
        : null;
    } catch {
      return null;
    }
  }

  async resolveId(): Promise<string | null> {
    return (await this.resolve())?.id ?? null;
  }
}
