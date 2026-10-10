export const WEIGHT_MAX = 10;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > WEIGHT_MAX) return WEIGHT_MAX;
  return value;
}

export function nonNegativeOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function batteryCost(
  distance: number,
  energyLevel: number,
  batteryWeight: number,
): number {
  const lowBatteryShare = 1 - clamp01(energyLevel / 100);
  const cost = distance * (1 + clampWeight(batteryWeight) * lowBatteryShare);
  return Number.isFinite(cost) && cost >= 0 ? cost : distance;
}
