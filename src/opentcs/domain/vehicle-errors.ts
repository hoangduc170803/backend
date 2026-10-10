export interface KernelVehicleErrors {
  fatal: string[];
  warning: string[];
  descriptions?: Record<string, string>;
}

export const VEHICLE_ERROR_PROPERTY_KEYS = {
  FATAL: 'vda5050:errors.fatal',
  WARNING: 'vda5050:errors.warning',
  DESCRIPTIONS: 'fms:errorDescriptions',
} as const;

export const ADAPTER_LOST_NAVIGATION = 'adapterLostNavigation';

export function hasLostNavigation(
  errors: KernelVehicleErrors | undefined,
): boolean {
  return errors?.fatal.includes(ADAPTER_LOST_NAVIGATION) ?? false;
}

export function emptyVehicleErrors(): KernelVehicleErrors {
  return { fatal: [], warning: [] };
}

export function parseVehicleErrorTypes(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').reduce<string[]>((errorTypes, raw) => {
    const errorType = raw.trim();
    if (errorType.length > 0) errorTypes.push(errorType);
    return errorTypes;
  }, []);
}

export function toVehicleErrors(
  properties: Record<string, string> | undefined,
): KernelVehicleErrors {
  const descriptions = parseVehicleErrorDescriptions(
    properties?.[VEHICLE_ERROR_PROPERTY_KEYS.DESCRIPTIONS],
  );
  return {
    fatal: parseVehicleErrorTypes(
      properties?.[VEHICLE_ERROR_PROPERTY_KEYS.FATAL],
    ),
    warning: parseVehicleErrorTypes(
      properties?.[VEHICLE_ERROR_PROPERTY_KEYS.WARNING],
    ),
    ...(Object.keys(descriptions).length > 0 && { descriptions }),
  };
}

export function parseVehicleErrorDescriptions(
  value: string | undefined,
): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const descriptions: Record<string, string> = {};
  for (const [errorType, description] of Object.entries(parsed)) {
    if (typeof description === 'string' && description.trim().length > 0) {
      descriptions[errorType] = description.trim();
    }
  }
  return descriptions;
}

export function hasVehicleErrors(
  errors: KernelVehicleErrors | undefined,
): boolean {
  return (errors?.fatal.length ?? 0) > 0 || (errors?.warning.length ?? 0) > 0;
}

export function vehicleErrorsEqual(
  a: KernelVehicleErrors | undefined,
  b: KernelVehicleErrors | undefined,
): boolean {
  return (
    sameErrorTypes(a?.fatal, b?.fatal) &&
    sameErrorTypes(a?.warning, b?.warning) &&
    sameDescriptions(a?.descriptions, b?.descriptions)
  );
}

function sameDescriptions(
  a: Record<string, string> = {},
  b: Record<string, string> = {},
): boolean {
  const errorTypes = Object.keys(a);
  return (
    errorTypes.length === Object.keys(b).length &&
    errorTypes.every((errorType) => a[errorType] === b[errorType])
  );
}

function sameErrorTypes(a: string[] = [], b: string[] = []): boolean {
  return a.length === b.length && a.every((errorType, i) => errorType === b[i]);
}
