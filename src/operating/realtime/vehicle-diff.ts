import type { VehicleRealtimeDto } from '../dto/operating.dto';

const CRITICAL_FIELDS: ReadonlySet<keyof VehicleRealtimeDto> = new Set([
  'state',
  'procState',
  'integrationLevel',
  'transportOrder',
  'paused',
  'reportedPaused',
  'loaded',
  'fatalErrorCodes',
  'warningErrorCodes',
  'errorDescriptions',
  'serialNumber',
]);

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface VehicleDiff {
  changes: Partial<VehicleRealtimeDto>;
  changed: boolean;
  critical: boolean;
}

export function diffVehicle(
  previous: VehicleRealtimeDto,
  next: VehicleRealtimeDto,
): VehicleDiff {
  const changes: Record<string, unknown> = {};
  let critical = false;
  for (const key of Object.keys(next) as (keyof VehicleRealtimeDto)[]) {
    if (sameValue(previous[key], next[key])) continue;
    changes[key] = next[key];
    if (CRITICAL_FIELDS.has(key)) critical = true;
  }
  return {
    changes: changes,
    changed: Object.keys(changes).length > 0,
    critical,
  };
}
