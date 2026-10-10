import {
  canYieldChargeSlot,
  isCritical,
  isFullyCharged,
  isGoodForWork,
  isLow,
  type BatteryThresholds,
} from '../../agvs/domain/battery-thresholds';

export interface ChargeLocation {
  readonly name: string;
  readonly points: readonly string[];
}

export interface ChargeVehicleCandidate {
  readonly name: string;
  readonly ignored: boolean;
  readonly dispatchEnabled: boolean;
  readonly idleAvailable: boolean;
  readonly enRouteToPark: boolean;
  readonly charging: boolean;
  readonly onOrder: boolean;
  readonly hasActiveTask: boolean;
  readonly currentPosition: string | null;
  readonly energyLevel: number;
  readonly thresholds: BatteryThresholds;
}

function isFreeOffCharger(
  c: ChargeVehicleCandidate,
  chargePointNames: ReadonlySet<string>,
): boolean {
  return (
    !c.ignored &&
    !c.hasActiveTask &&
    c.currentPosition !== null &&
    !chargePointNames.has(c.currentPosition)
  );
}

function isIdleWithoutOrder(c: ChargeVehicleCandidate): boolean {
  return c.idleAvailable && !c.onOrder;
}

export function needsCharging(
  c: ChargeVehicleCandidate,
  chargePointNames: ReadonlySet<string>,
): boolean {
  return (
    isFreeOffCharger(c, chargePointNames) &&
    (isIdleWithoutOrder(c) || c.enRouteToPark) &&
    isCritical(c.energyLevel, c.thresholds)
  );
}

export function wantsOpportunisticCharge(
  c: ChargeVehicleCandidate,
  chargePointNames: ReadonlySet<string>,
  hasPendingWork: boolean,
): boolean {
  return (
    !hasPendingWork &&
    isFreeOffCharger(c, chargePointNames) &&
    isIdleWithoutOrder(c) &&
    isLow(c.energyLevel, c.thresholds)
  );
}

export function isReleaseCandidate(c: ChargeVehicleCandidate): boolean {
  return c.charging && !c.onOrder;
}

export function shouldRelease(c: ChargeVehicleCandidate): boolean {
  return isFullyCharged(c.energyLevel, c.thresholds);
}

export function canYieldSlot(c: ChargeVehicleCandidate): boolean {
  return (
    isReleaseCandidate(c) &&
    !c.hasActiveTask &&
    canYieldChargeSlot(c.energyLevel, c.thresholds)
  );
}

export function pickSlotDonor(
  candidates: readonly ChargeVehicleCandidate[],
): ChargeVehicleCandidate | null {
  return (
    candidates
      .filter(canYieldSlot)
      .sort(
        (a, b) => b.energyLevel - a.energyLevel || a.name.localeCompare(b.name),
      )[0] ?? null
  );
}

export function isRecallableForWork(c: ChargeVehicleCandidate): boolean {
  return (
    !c.ignored &&
    c.dispatchEnabled &&
    isGoodForWork(c.energyLevel, c.thresholds)
  );
}

export function pickChargeLocation(
  locations: readonly ChargeLocation[],
  distanceByPoint: ReadonlyMap<string, number>,
  freeSlots: ReadonlyMap<string, number>,
): ChargeLocation | null {
  return (
    locations
      .filter((loc) => (freeSlots.get(loc.name) ?? 0) > 0)
      .map((loc) => ({
        loc,
        distance: Math.min(
          ...loc.points.map((point) => distanceByPoint.get(point) ?? Infinity),
        ),
      }))
      .filter((x) => Number.isFinite(x.distance))
      .sort(
        (a, b) =>
          a.distance - b.distance || a.loc.name.localeCompare(b.loc.name),
      )[0]?.loc ?? null
  );
}
