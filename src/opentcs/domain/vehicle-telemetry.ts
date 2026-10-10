export const BATTERY_VOLTAGE_PROPERTY = 'fms:batteryVoltage';

export const TELEMETRY_PROPERTIES: ReadonlySet<string> = new Set([
  BATTERY_VOLTAGE_PROPERTY,
]);

export function batteryVoltageOf(
  properties: Readonly<Record<string, string>> | undefined,
): number | null {
  const raw = properties?.[BATTERY_VOLTAGE_PROPERTY];
  if (raw === undefined || raw.trim() === '') return null;
  const volts = Number(raw);
  return Number.isFinite(volts) && volts > 0 ? volts : null;
}
