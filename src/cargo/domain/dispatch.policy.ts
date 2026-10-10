import { batteryCost } from './dispatch-cost';
import { solveHungarian } from './hungarian';

export interface VehicleCandidate {
  readonly name: string;
  readonly dispatchEnabled: boolean;
  readonly ignored: boolean;
  readonly available: boolean;
  readonly preemptibleParking: boolean;
  readonly energyLevel: number;
  readonly criticalThreshold: number;
  readonly currentPosition: string | null;
  hasActiveTask: boolean;
}

export function isEligible(c: VehicleCandidate): boolean {
  return (
    c.dispatchEnabled &&
    !c.ignored &&
    (c.available || c.preemptibleParking) &&
    !c.hasActiveTask &&
    c.energyLevel > c.criticalThreshold
  );
}

export function pickVehicle(
  candidates: readonly VehicleCandidate[],
): VehicleCandidate | null {
  return (
    candidates
      .filter(isEligible)
      .sort((a, b) => a.name.localeCompare(b.name))[0] ?? null
  );
}

export function pickNearestVehicle(
  candidates: readonly VehicleCandidate[],
  distanceByPoint: ReadonlyMap<string, number>,
): VehicleCandidate | null {
  const costOf = (c: VehicleCandidate): number =>
    c.currentPosition
      ? (distanceByPoint.get(c.currentPosition) ?? Infinity)
      : Infinity;
  return (
    candidates.filter(isEligible).sort((a, b) => {
      const delta = costOf(a) - costOf(b);
      return delta !== 0 ? delta : a.name.localeCompare(b.name);
    })[0] ?? null
  );
}

export interface DispatchTaskCandidate {
  readonly taskId: string;
  readonly distanceByPoint: ReadonlyMap<string, number> | null;
  readonly approachDistance?: number | null;
}

export interface VehicleTaskAssignment {
  readonly taskId: string;
  readonly vehicle: VehicleCandidate;
  readonly distance: number | null;
}

export type DispatchMatcher = 'hungarian' | 'greedy';

export function planVehicleAssignments(
  candidates: readonly VehicleCandidate[],
  tasks: readonly DispatchTaskCandidate[],
  batteryWeight = 0,
): VehicleTaskAssignment[] {
  const batch = buildBatch(candidates, tasks, batteryWeight);
  if (!batch) return [];
  return toAssignments(batch, solveHungarian(batch.costMatrix).assignment);
}

export function planVehicleAssignmentsGreedy(
  candidates: readonly VehicleCandidate[],
  tasks: readonly DispatchTaskCandidate[],
  batteryWeight = 0,
): VehicleTaskAssignment[] {
  const batch = buildBatch(candidates, tasks, batteryWeight);
  if (!batch) return [];
  return toAssignments(batch, cheapestFreeVehiclePerTask(batch.costMatrix));
}

interface DispatchBatch {
  readonly vehicles: readonly VehicleCandidate[];
  readonly selectedTasks: readonly DispatchTaskCandidate[];
  readonly pairs: readonly (readonly PairEvaluation[])[];
  readonly costMatrix: readonly (readonly number[])[];
}

function loadedApproachDistance(task: DispatchTaskCandidate): number {
  const distance = task.approachDistance;
  return typeof distance === 'number' &&
    Number.isFinite(distance) &&
    distance > 0
    ? distance
    : 0;
}

function buildBatch(
  candidates: readonly VehicleCandidate[],
  tasks: readonly DispatchTaskCandidate[],
  batteryWeight: number,
): DispatchBatch | null {
  const vehicles = uniqueEligibleVehicles(candidates);
  const selectedTasks = tasks.slice(0, vehicles.length);
  if (vehicles.length === 0 || selectedTasks.length === 0) return null;

  const pairs = selectedTasks.map((task) =>
    vehicles.map((vehicle) => evaluatePair(task, vehicle)),
  );
  const reachableCosts = pairs.map((row, taskIndex) =>
    row.map((pair, vehicleIndex) => {
      if (pair.kind !== 'reachable') return null;
      if (batteryWeight <= 0) return pair.distance;
      return batteryCost(
        pair.distance + loadedApproachDistance(selectedTasks[taskIndex]),
        vehicles[vehicleIndex].energyLevel,
        batteryWeight,
      );
    }),
  );
  const maxCost = reachableCosts
    .flat()
    .reduce<number>(
      (maximum, cost) => (cost !== null ? Math.max(maximum, cost) : maximum),
      0,
    );
  const batchScale = selectedTasks.length + 1;
  const unknownCost = (maxCost + 1) * batchScale;
  const unreachableCost = unknownCost * batchScale;

  if (!Number.isFinite(unreachableCost)) {
    throw new RangeError('Dispatch distance matrix exceeds numeric range');
  }

  const costMatrix = pairs.map((row, taskIndex) =>
    row.map((pair, vehicleIndex) => {
      if (pair.kind === 'reachable') {
        return reachableCosts[taskIndex][vehicleIndex] as number;
      }
      return pair.kind === 'unknown' ? unknownCost : unreachableCost;
    }),
  );
  return { vehicles, selectedTasks, pairs, costMatrix };
}

function toAssignments(
  batch: DispatchBatch,
  assignment: readonly number[],
): VehicleTaskAssignment[] {
  return batch.selectedTasks.flatMap((task, taskIndex) => {
    const vehicleIndex = assignment[taskIndex];
    if (vehicleIndex < 0) return [];
    const pair = batch.pairs[taskIndex][vehicleIndex];
    if (pair.kind === 'unreachable') {
      return [];
    }
    return [
      {
        taskId: task.taskId,
        vehicle: batch.vehicles[vehicleIndex],
        distance: pair.kind === 'reachable' ? pair.distance : null,
      },
    ];
  });
}

function cheapestFreeVehiclePerTask(
  costMatrix: readonly (readonly number[])[],
): number[] {
  const taken = new Set<number>();
  return costMatrix.map((row) => {
    let chosen = -1;
    let chosenCost = Infinity;
    row.forEach((cost, vehicleIndex) => {
      if (taken.has(vehicleIndex) || cost >= chosenCost) return;
      chosen = vehicleIndex;
      chosenCost = cost;
    });
    if (chosen >= 0) taken.add(chosen);
    return chosen;
  });
}

export function hasDispatchableVehicle(
  candidates: readonly VehicleCandidate[],
  task: DispatchTaskCandidate,
): boolean {
  return uniqueEligibleVehicles(candidates).some(
    (vehicle) => evaluatePair(task, vehicle).kind !== 'unreachable',
  );
}

function uniqueEligibleVehicles(
  candidates: readonly VehicleCandidate[],
): VehicleCandidate[] {
  return candidates
    .filter(isEligible)
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(
      (vehicle, index, sorted) =>
        index === 0 || sorted[index - 1].name !== vehicle.name,
    );
}

type PairEvaluation =
  | { readonly kind: 'reachable'; readonly distance: number }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unreachable' };

function evaluatePair(
  task: DispatchTaskCandidate,
  vehicle: VehicleCandidate,
): PairEvaluation {
  const position = vehicle.currentPosition;
  if (!task.distanceByPoint || !position) {
    return { kind: 'unknown' };
  }
  const toSource = task.distanceByPoint.get(position);
  if (toSource === undefined || !Number.isFinite(toSource) || toSource < 0) {
    return { kind: 'unreachable' };
  }
  return { kind: 'reachable', distance: toSource };
}
