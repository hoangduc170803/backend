import type { ZoneLane } from './zone-slot-layout';

export const NO_PROGRESS_MS = 5_000;
export const LANE_LATCH_MS = 10_000;
export const MAX_SLOT_SWAPS = 3;

export interface LaneStanding {
  readonly cargoId: string;
  readonly posDepth: number;
  readonly targetDepth: number;
  readonly committed: boolean;
  readonly unloaded: boolean;
  readonly swapCount: number;
}

export interface LaneWatermark {
  readonly bestDistanceByCargo: ReadonlyMap<string, number>;
  readonly lastProgressAt: number;
}

export interface LaneInversion<T> {
  readonly ahead: T;
  readonly holder: T;
}

export function depthOfTarget(lane: ZoneLane, target: string): number {
  const slot = lane.slots.find((cell) => cell.locationName === target);
  return lane.axisPoints.indexOf(slot?.pointName ?? target);
}

export function distanceToTarget(standing: LaneStanding): number {
  return Math.abs(standing.posDepth - standing.targetDepth);
}

export function inversionIn<T extends LaneStanding>(
  standings: readonly T[],
): LaneInversion<T> | null {
  const deepestFirst = [...standings].sort((a, b) => a.posDepth - b.posDepth);
  const ahead = deepestFirst.find((standing) => !standing.committed);
  if (!ahead) return null;

  const holder = deepestFirst.find(
    (standing) =>
      standing.committed &&
      !standing.unloaded &&
      standing.posDepth > ahead.posDepth,
  );
  return holder ? { ahead, holder } : null;
}

export function afterMoving(
  mark: LaneWatermark | undefined,
  standings: readonly LaneStanding[],
  now: number,
): LaneWatermark {
  const best = new Map(mark?.bestDistanceByCargo ?? []);
  const present = new Set(standings.map((standing) => standing.cargoId));
  let improved = false;

  for (const standing of standings) {
    const distance = distanceToTarget(standing);
    const seen = best.get(standing.cargoId);
    if (seen === undefined || distance < seen) {
      best.set(standing.cargoId, distance);
      improved = true;
    }
  }
  for (const cargoId of [...best.keys()]) {
    if (!present.has(cargoId)) best.delete(cargoId);
  }

  return {
    bestDistanceByCargo: best,
    lastProgressAt: !mark || improved ? now : mark.lastProgressAt,
  };
}

export function stuckForMs(mark: LaneWatermark, now: number): number {
  return now - mark.lastProgressAt;
}
