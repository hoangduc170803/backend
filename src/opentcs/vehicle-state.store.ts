import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import type { KernelVehicleState } from './domain/kernel-model';
import { TELEMETRY_PROPERTIES } from './domain/vehicle-telemetry';

const FMS_PROPERTY_PREFIX = 'fms:';

function fmsProperties(state: KernelVehicleState | undefined): string {
  const entries = Object.entries(state?.properties ?? {})
    .filter(
      ([key]) =>
        key.startsWith(FMS_PROPERTY_PREFIX) && !TELEMETRY_PROPERTIES.has(key),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${value}`).join(' ') || '(none)';
}

function fingerprintIgnoringObservedAt(state: KernelVehicleState): string {
  const fields: Record<string, unknown> = { ...state };
  delete fields.observedAt;
  return JSON.stringify(fields);
}

@Injectable()
export class VehicleStateStore {
  private readonly logger = new Logger(VehicleStateStore.name);
  private readonly states = new Map<string, KernelVehicleState>();
  private readonly fingerprints = new Map<string, string>();
  private readonly updates = new Subject<KernelVehicleState>();
  private connected = false;
  private eventCount = 0;
  private lastEventAt: Date | null = null;

  setConnected(value: boolean): void {
    this.connected = value;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** How many de-duplicated vehicle updates have actually reached subscribers, and when the last
   *  one was — lets `/operating/health` tell "connected but stale" apart from "connected and
   *  flowing", instead of a fixed `connected: boolean` that can't distinguish the two. */
  getEventStats(): { eventCount: number; lastEventAt: string | null } {
    return {
      eventCount: this.eventCount,
      lastEventAt: this.lastEventAt?.toISOString() ?? null,
    };
  }

  set(name: string, state: KernelVehicleState): void {
    const fingerprint = fingerprintIgnoringObservedAt(state);
    if (this.fingerprints.get(name) === fingerprint) return;

    const before = fmsProperties(this.states.get(name));
    const after = fmsProperties(state);
    if (before !== after) {
      this.logger.log(`${name} fms properties: ${before} -> ${after}`);
    }
    this.fingerprints.set(name, fingerprint);
    this.states.set(name, state);
    this.eventCount += 1;
    this.lastEventAt = new Date();
    this.updates.next(state);
  }

  get(name: string): KernelVehicleState | undefined {
    return this.states.get(name);
  }

  getAll(): KernelVehicleState[] {
    return [...this.states.values()];
  }

  get vehicleUpdates(): Observable<KernelVehicleState> {
    return this.updates.asObservable();
  }
}
