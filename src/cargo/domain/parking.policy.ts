import { parkPointFromOrderName } from '../../opentcs/domain/transport-order';

export interface ParkingPoint {
  readonly name: string;
  readonly priority: number | null;
}

export interface ParkOccupancy {
  readonly name: string;
  readonly currentPosition: string | null;
  readonly transportOrder?: string | null;
}

export interface ParkVehicleCandidate {
  readonly name: string;
  readonly dispatchEnabled: boolean;
  readonly ignored: boolean;
  readonly idleAvailable: boolean;
  readonly onOrder: boolean;
  readonly hasActiveTask: boolean;
  readonly belowCritical: boolean;
  readonly charging: boolean;
  readonly currentPosition: string | null;
}

export function needsParking(
  c: ParkVehicleCandidate,
  parkingPointNames: ReadonlySet<string>,
  hasPendingWork: boolean,
): boolean {
  if (hasPendingWork && c.dispatchEnabled) return false;
  return (
    !c.ignored &&
    c.idleAvailable &&
    !c.onOrder &&
    !c.hasActiveTask &&
    !c.belowCritical &&
    !c.charging &&
    c.currentPosition !== null &&
    !parkingPointNames.has(c.currentPosition)
  );
}

export function mustClearChargePoint(
  c: ParkVehicleCandidate,
  reservedChargePoints: ReadonlySet<string>,
): boolean {
  return (
    !c.ignored &&
    c.idleAvailable &&
    !c.onOrder &&
    !c.hasActiveTask &&
    !c.charging &&
    c.currentPosition !== null &&
    reservedChargePoints.has(c.currentPosition)
  );
}

export function mustLeaveZone(
  c: ParkVehicleCandidate,
  zonePoints: ReadonlySet<string>,
): boolean {
  return (
    !c.ignored &&
    c.idleAvailable &&
    !c.onOrder &&
    !c.hasActiveTask &&
    !c.charging &&
    !c.belowCritical &&
    c.currentPosition !== null &&
    zonePoints.has(c.currentPosition)
  );
}

export function unavailableParkPoints(
  states: readonly ParkOccupancy[],
  parkPointNames: ReadonlySet<string>,
): Set<string> {
  const excluded = new Set<string>();
  for (const state of states) {
    const position = state.currentPosition;
    if (position && parkPointNames.has(position)) excluded.add(position);

    const target = parkPointFromOrderName(state.transportOrder, state.name);
    if (target && parkPointNames.has(target)) excluded.add(target);
  }
  return excluded;
}

export function pickParkingPoint(
  points: readonly ParkingPoint[],
  distanceByPoint: ReadonlyMap<string, number>,
  excluded: ReadonlySet<string>,
): ParkingPoint | null {
  return (
    points
      .filter((p) => !excluded.has(p.name))
      .map((p) => ({
        point: p,
        distance: distanceByPoint.get(p.name) ?? Infinity,
      }))
      .filter((x) => Number.isFinite(x.distance))
      .sort((a, b) => {
        const pa = a.point.priority ?? Number.MAX_SAFE_INTEGER;
        const pb = b.point.priority ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.point.name.localeCompare(b.point.name);
      })[0]?.point ?? null
  );
}
