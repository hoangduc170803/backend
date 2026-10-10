import type { VehicleTaskAssignment } from './dispatch.policy';

export interface CounterfactualRecord {
  readonly altVehicleName: string | null;
  readonly altDistanceToSource: number | null;
}

const NOT_COMPARABLE: CounterfactualRecord = {
  altVehicleName: null,
  altDistanceToSource: null,
};

export function summariseDistance(
  plan: readonly VehicleTaskAssignment[],
): string {
  const known = plan.flatMap(({ distance }) =>
    distance === null ? [] : [distance],
  );
  return `${known.reduce((sum, distance) => sum + distance, 0)}(${known.length}/${plan.length})`;
}

export function comparableCounterfactual(
  alternative: VehicleTaskAssignment | undefined,
): CounterfactualRecord {
  if (!alternative) return NOT_COMPARABLE;
  return {
    altVehicleName: alternative.vehicle.name,
    altDistanceToSource: alternative.distance,
  };
}
