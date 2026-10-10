import { allocatedPointNames } from './lane-safety.policy';

export interface PickupCandidate {
  readonly taskId: string;
  readonly laneKey: number;
  readonly depthKey: number;
  readonly locationName: string;
  readonly atSource: boolean;
  readonly vehicleName: string | null;
  readonly vehicleLeftColumn: boolean;
}

export function hasLeftColumn(
  resources: readonly (readonly string[])[],
  lanePoints: ReadonlySet<string>,
): boolean {
  return allocatedPointNames(resources).some((point) => !lanePoints.has(point));
}

export function stillOccupiesLane(candidate: PickupCandidate): boolean {
  return candidate.atSource || !candidate.vehicleLeftColumn;
}

export function findBlocker(
  target: PickupCandidate,
  others: readonly PickupCandidate[],
): PickupCandidate | null {
  let blocker: PickupCandidate | null = null;
  for (const o of others) {
    if (o.taskId === target.taskId) continue;
    if (o.laneKey !== target.laneKey) continue;
    if (o.depthKey >= target.depthKey) continue;
    if (!stillOccupiesLane(o)) continue;
    if (!blocker || o.depthKey < blocker.depthKey) blocker = o;
  }
  return blocker;
}

export function isBlocked(
  target: PickupCandidate,
  others: readonly PickupCandidate[],
): boolean {
  return findBlocker(target, others) !== null;
}
