import type { LaneAxis } from './mainline';
import { pointNameOf } from './location-naming';
import {
  checkLaneInvariants,
  checkZoneReachability,
  type LaneInvariantViolation,
  type PlantPath,
  type TopologyPoint,
} from './zone-topology';

export type LayoutProblem =
  | { readonly kind: 'unreachable'; readonly locationNames: string[] }
  | {
      readonly kind: 'lane-invariant';
      readonly violations: LaneInvariantViolation[];
    };

export interface LayoutReview {
  readonly problems: LayoutProblem[];
  readonly noFeeder: boolean;
  readonly longDetour: {
    readonly maxHops: number;
    readonly members: number;
  } | null;
}

export function reviewDropoffLayout(
  points: readonly TopologyPoint[],
  paths: readonly PlantPath[],
  memberLocationNames: readonly string[],
  laneAxis: LaneAxis = 'y',
): LayoutReview {
  const locationByPoint = new Map(
    memberLocationNames.map((name) => [pointNameOf(name), name] as const),
  );
  const memberPointNames = new Set(locationByPoint.keys());

  const { feeders, unreachable, maxHops } = checkZoneReachability(
    paths,
    memberPointNames,
  );
  if (feeders.length === 0) {
    return { problems: [], noFeeder: true, longDetour: null };
  }

  if (unreachable.length > 0) {
    return {
      problems: [
        {
          kind: 'unreachable',
          locationNames: unreachable.map(
            (point) => locationByPoint.get(point) ?? point,
          ),
        },
      ],
      noFeeder: false,
      longDetour: null,
    };
  }

  const violations = checkLaneInvariants(
    points,
    paths,
    memberPointNames,
    laneAxis,
  );
  return {
    problems:
      violations.length > 0 ? [{ kind: 'lane-invariant', violations }] : [],
    noFeeder: false,
    longDetour:
      maxHops > memberPointNames.size
        ? { maxHops, members: memberPointNames.size }
        : null,
  };
}
