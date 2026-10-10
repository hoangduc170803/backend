export interface KernelPlantModelSummary {
  name: string;
  pointCount: number;
  pathCount: number;
  vehicleCount: number;
}

/**
 * Reduces the kernel's raw plant model JSON to a summary, or null when there's effectively no
 * model loaded — either the value isn't model-shaped at all, or it's the kernel's own sentinel
 * for "nothing loaded" (an empty model literally named "unnamed").
 */
export function toPlantModelSummary(
  value: unknown,
): KernelPlantModelSummary | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const model = value as Record<string, unknown>;
  if (typeof model.name !== 'string') {
    return null;
  }

  const pointCount = Array.isArray(model.points) ? model.points.length : 0;
  const pathCount = Array.isArray(model.paths) ? model.paths.length : 0;
  const vehicleCount = Array.isArray(model.vehicles)
    ? model.vehicles.length
    : 0;
  const locationCount = Array.isArray(model.locations)
    ? model.locations.length
    : 0;

  const isUnnamedEmptyModel =
    model.name === 'unnamed' &&
    pointCount === 0 &&
    pathCount === 0 &&
    vehicleCount === 0 &&
    locationCount === 0;
  if (isUnnamedEmptyModel) {
    return null;
  }

  return {
    name: model.name,
    pointCount,
    pathCount,
    vehicleCount,
  };
}
