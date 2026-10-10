export interface BatteryThresholds {
  readonly critical: number;
  readonly good: number;
  readonly sufficient: number;
  readonly full: number;
}

export interface BatteryThresholdColumns {
  readonly criticalBatteryThreshold: number;
  readonly goodBatteryThreshold: number;
  readonly sufficientBatteryThreshold: number;
  readonly fullBatteryThreshold: number;
}

export const DEFAULT_BATTERY_THRESHOLDS: BatteryThresholds = {
  critical: 35,
  good: 50,
  sufficient: 60,
  full: 95,
};

export function thresholdsOf(
  columns: Partial<BatteryThresholdColumns>,
): BatteryThresholds {
  return {
    critical:
      columns.criticalBatteryThreshold ?? DEFAULT_BATTERY_THRESHOLDS.critical,
    good: columns.goodBatteryThreshold ?? DEFAULT_BATTERY_THRESHOLDS.good,
    sufficient:
      columns.sufficientBatteryThreshold ??
      DEFAULT_BATTERY_THRESHOLDS.sufficient,
    full: columns.fullBatteryThreshold ?? DEFAULT_BATTERY_THRESHOLDS.full,
  };
}

export function batteryThresholdError(t: BatteryThresholds): string | null {
  const values = [t.critical, t.good, t.sufficient, t.full];
  if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 100)) {
    return 'Các ngưỡng pin phải là số nguyên từ 0 đến 100.';
  }
  if (t.critical >= t.sufficient) {
    return 'Ngưỡng nguy hiểm (critical) phải nhỏ hơn ngưỡng đủ (sufficient).';
  }
  if (t.sufficient > t.full) {
    return 'Ngưỡng đủ (sufficient) không được lớn hơn ngưỡng đầy (full).';
  }
  if (t.critical > t.good) {
    return 'Ngưỡng tốt (good) không được nhỏ hơn ngưỡng nguy hiểm (critical).';
  }
  return null;
}

export type EnergyBand = 'CRITICAL' | 'LOW' | 'GOOD';

export function energyBand(energy: number, t: BatteryThresholds): EnergyBand {
  if (energy <= t.critical) return 'CRITICAL';
  if (energy < t.good) return 'LOW';
  return 'GOOD';
}

export function isCritical(energy: number, t: BatteryThresholds): boolean {
  return energyBand(energy, t) === 'CRITICAL';
}

export function isLow(energy: number, t: BatteryThresholds): boolean {
  return energyBand(energy, t) === 'LOW';
}

export function isGoodForWork(energy: number, t: BatteryThresholds): boolean {
  return energyBand(energy, t) === 'GOOD';
}

export function canYieldChargeSlot(
  energy: number,
  t: BatteryThresholds,
): boolean {
  return energy >= t.sufficient;
}

export function isFullyCharged(energy: number, t: BatteryThresholds): boolean {
  return energy >= t.full;
}
