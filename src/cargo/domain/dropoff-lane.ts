import type { ZoneOccupancy } from './zone-occupancy';
import {
  ColumnQueue,
  targetOf,
  type ColumnClaims,
  type QueueNode,
} from './column-queue';
import {
  eligibleLanes,
  laneIndexOfTarget,
  type ZoneLane,
  type ZoneSlotLayout,
} from './zone-slot-layout';

export interface LaneSpot {
  readonly lane: ZoneLane;
  readonly depth: number;
}

export function spotInReservedLane(
  layout: ZoneSlotLayout,
  reservedTarget: string,
  pointName: string,
): LaneSpot | null {
  const laneIndex = laneIndexOfTarget(layout, reservedTarget);
  if (laneIndex === null) return null;

  const lane = layout.lanes[laneIndex];
  const depth = lane.axisPoints.indexOf(pointName);
  return depth === -1 ? null : { lane, depth };
}

export function standsOnASlot(lane: ZoneLane, pointName: string): boolean {
  return lane.slots.some((slot) => slot.pointName === pointName);
}

export function serveOrder<T extends { readonly depth: number }>(
  spots: readonly T[],
): T[] {
  return [...spots].sort((a, b) => a.depth - b.depth);
}

export function queueOfLane(
  layout: ZoneSlotLayout,
  laneIndex: number,
  claims: ColumnClaims,
): ColumnQueue {
  return ColumnQueue.of(nodesOf(layout.lanes[laneIndex], layout), claims);
}

function nodesOf(lane: ZoneLane, layout: ZoneSlotLayout): QueueNode[] {
  const locationOf = new Map(
    lane.slots.map((slot) => [slot.pointName, slot.locationName] as const),
  );
  const nodes: QueueNode[] = [];
  for (const [index, pointName] of lane.axisPoints.entries()) {
    if (layout.mainlinePoints.has(pointName)) break;
    nodes.push({
      pointName,
      locationName: locationOf.get(pointName) ?? null,
      along: lane.axisAlong[index],
    });
  }
  return nodes;
}

function lanesWorthAsking(
  layout: ZoneSlotLayout,
  occupancy: ZoneOccupancy,
): number[] {
  const eligible = eligibleLanes(occupancy.activeCountByLane());
  const first = eligible.indexOf(true);
  if (first === -1) return [];
  return layout.lanes.map((_, index) => index).slice(first);
}

export function whereToQueue(
  layout: ZoneSlotLayout,
  occupancy: ZoneOccupancy,
): string | null {
  const claims = occupancy.columnClaims();
  for (const index of lanesWorthAsking(layout, occupancy)) {
    const target = backOfTheQueueIn(layout, index, claims);
    if (target) return target;
  }
  return null;
}

function targetOfPoint(lane: ZoneLane, pointName: string): string {
  return (
    lane.slots.find((slot) => slot.pointName === pointName)?.locationName ??
    pointName
  );
}

function backOfTheQueueIn(
  layout: ZoneSlotLayout,
  laneIndex: number,
  claims: ColumnClaims,
): string | null {
  const lane = layout.lanes[laneIndex];
  const isHeld = (target: string): boolean =>
    claims.reserved.has(target) || claims.committed.has(target);

  const deepestHeld = lane.axisPoints.reduce(
    (deepest, pointName, index) =>
      isHeld(targetOfPoint(lane, pointName)) ? index : deepest,
    -1,
  );
  const depthOf = new Map(
    lane.axisPoints.map((pointName, index) => [pointName, index] as const),
  );

  const free = queueOfLane(layout, laneIndex, claims)
    .standing()
    .find(
      (node) =>
        (depthOf.get(node.pointName) ?? -1) > deepestHeld &&
        !isHeld(targetOf(node)),
    );
  return free ? targetOf(free) : null;
}

export function queueDiagnosis(
  layout: ZoneSlotLayout,
  occupancy: ZoneOccupancy,
): string[] {
  const claims = occupancy.columnClaims();
  const worthAsking = new Set(lanesWorthAsking(layout, occupancy));
  return layout.lanes.map((_, index) => {
    const queue = queueOfLane(layout, index, claims);
    const skipped = worthAsking.has(index) ? '' : ', not eligible to fill yet';
    return `lane ${index} (${queue.describe()}${skipped})`;
  });
}
