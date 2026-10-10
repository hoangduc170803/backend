import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject } from 'rxjs';
import { FMS_EVENTS } from '../../cargo/domain/events';

/**
 * Fires whenever a different map is loaded into the kernel — every vehicle/order/cargo/area an
 * operating client has cached belongs to the map that was just replaced. Kept as its own tiny
 * service (rather than folded into one of the other Operating*Service classes) because it fans
 * out to all of them equally; `stream.controller.ts` merges `changes$` in as its own SSE kind so
 * clients can resync everything in one shot instead of waiting for an unrelated event.
 */
@Injectable()
export class OperatingMapSyncService {
  private readonly ticks = new Subject<void>();

  get changes$(): Observable<void> {
    return this.ticks.asObservable();
  }

  @OnEvent(FMS_EVENTS.MAP_LOADED)
  onMapLoaded(): void {
    this.ticks.next();
  }
}
