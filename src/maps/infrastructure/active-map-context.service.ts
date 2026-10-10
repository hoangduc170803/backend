import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActiveMapRecordService } from './active-map-record.service';
import { FMS_EVENTS, FmsMapLoadedEvent } from '../../cargo/domain/events';

const VERIFIED_TTL_MS = 30_000;
const UNRESOLVED_RETRY_MS = 5_000;

@Injectable()
export class ActiveMapContext {
  private readonly logger = new Logger(ActiveMapContext.name);
  private current: string | null = null;
  private verifiedAt = 0;
  private refreshing: Promise<string | null> | null = null;

  constructor(private readonly activeMapRecords: ActiveMapRecordService) {}

  async id(): Promise<string | null> {
    return this.isFresh() ? this.current : this.refresh();
  }

  @OnEvent(FMS_EVENTS.MAP_LOADED)
  onMapLoaded(event: FmsMapLoadedEvent): void {
    this.set(event.mapRecordId);
  }

  private isFresh(): boolean {
    const ttl = this.current ? VERIFIED_TTL_MS : UNRESOLVED_RETRY_MS;
    return this.verifiedAt > 0 && Date.now() - this.verifiedAt < ttl;
  }

  private refresh(): Promise<string | null> {
    this.refreshing ??= this.activeMapRecords
      .resolveId()
      .catch(() => null)
      .then((id) => {
        this.set(id);
        return id;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private set(id: string | null): void {
    if (id !== this.current) {
      const frozenNote = id
        ? ''
        : ' — every task stays frozen until a known map is loaded';
      this.logger.log(
        `Active map: ${this.current ?? 'none'} → ${id ?? 'none'}${frozenNote}`,
      );
    }
    this.current = id;
    this.verifiedAt = Date.now();
  }
}
