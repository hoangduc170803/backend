import {
  acrossLane,
  alongLane,
  type LaneAxis,
} from '../../zones/domain/mainline';

export const DROPOFF_RETREAT_CELLS = 2;

export interface RetreatGraphPoint {
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number };
}

export interface RetreatGraphPath {
  readonly srcPointName?: string;
  readonly destPointName?: string;
  readonly maxVelocity: number;
  readonly maxReverseVelocity: number;
  readonly locked?: boolean;
}

export interface RetreatGraph {
  readonly points: readonly RetreatGraphPoint[];
  readonly paths: readonly RetreatGraphPath[];
}

export interface RetreatPlan {
  readonly cells: readonly string[];
  readonly egress: string | null;
}

function traversableTargets(
  paths: readonly RetreatGraphPath[],
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  const connect = (from: string, to: string): void => {
    const existing = targets.get(from);
    if (existing) existing.add(to);
    else targets.set(from, new Set([to]));
  };

  for (const path of paths) {
    const src = path.srcPointName;
    const dest = path.destPointName;
    if (!src || !dest || path.locked) continue;
    if (path.maxVelocity > 0) connect(src, dest);
    if (path.maxReverseVelocity > 0) connect(dest, src);
  }
  return targets;
}

function isBehind(
  candidate: RetreatGraphPoint,
  current: RetreatGraphPoint,
  laneAxis: LaneAxis,
): boolean {
  return (
    acrossLane(laneAxis, candidate.position) ===
      acrossLane(laneAxis, current.position) &&
    alongLane(laneAxis, candidate.position) >
      alongLane(laneAxis, current.position)
  );
}

function nearestCellBehind(
  current: RetreatGraphPoint,
  points: readonly RetreatGraphPoint[],
  laneAxis: LaneAxis,
): RetreatGraphPoint | null {
  let nearest: RetreatGraphPoint | null = null;
  let nearestGap = Infinity;
  for (const candidate of points) {
    if (!isBehind(candidate, current, laneAxis)) continue;
    const gap =
      alongLane(laneAxis, candidate.position) -
      alongLane(laneAxis, current.position);
    if (gap >= nearestGap) continue;
    nearest = candidate;
    nearestGap = gap;
  }
  return nearest;
}

interface Walk {
  readonly cells: string[];
  readonly visited: Set<string>;
  current: RetreatGraphPoint;
}

function stepBehind(
  walk: Walk,
  points: readonly RetreatGraphPoint[],
  reachableFrom: ReadonlyMap<string, Set<string>>,
  laneAxis: LaneAxis,
): boolean {
  const behind = nearestCellBehind(walk.current, points, laneAxis);
  if (!behind || walk.visited.has(behind.name)) return false;
  if (!reachableFrom.get(walk.current.name)?.has(behind.name)) return false;
  walk.visited.add(behind.name);
  walk.cells.push(behind.name);
  walk.current = behind;
  return true;
}

function sidewaysNeighbour(
  from: RetreatGraphPoint,
  pointByName: ReadonlyMap<string, RetreatGraphPoint>,
  reachableFrom: ReadonlyMap<string, Set<string>>,
  laneAxis: LaneAxis,
): RetreatGraphPoint | null {
  let firstByName: RetreatGraphPoint | null = null;
  for (const name of reachableFrom.get(from.name) ?? []) {
    const point = pointByName.get(name);
    if (
      !point ||
      acrossLane(laneAxis, point.position) ===
        acrossLane(laneAxis, from.position)
    )
      continue;
    if (firstByName && firstByName.name.localeCompare(point.name) <= 0)
      continue;
    firstByName = point;
  }
  return firstByName;
}

function turnOffEveryLaneFrom(
  from: RetreatGraphPoint,
  pointByName: ReadonlyMap<string, RetreatGraphPoint>,
  reachableFrom: ReadonlyMap<string, Set<string>>,
  laneAxisPointNames: ReadonlySet<string>,
  occupiedPointNames: ReadonlySet<string>,
  laneAxis: LaneAxis,
): string | null {
  const crossed = new Set([from.name]);
  let current = from;
  for (;;) {
    const next = sidewaysNeighbour(
      current,
      pointByName,
      reachableFrom,
      laneAxis,
    );
    if (!next || crossed.has(next.name)) return null;
    if (!laneAxisPointNames.has(next.name)) return next.name;
    if (occupiedPointNames.has(next.name)) return null;
    crossed.add(next.name);
    current = next;
  }
}

function walkBehind(
  graph: RetreatGraph,
  dropPointName: string,
  cells: number,
  laneAxis: LaneAxis,
): { walk: Walk; reachableFrom: ReadonlyMap<string, Set<string>> } | null {
  if (cells < 1) return null;
  const start = graph.points.find((point) => point.name === dropPointName);
  if (!start) return null;

  const reachableFrom = traversableTargets(graph.paths);
  const walk: Walk = {
    cells: [],
    visited: new Set([start.name]),
    current: start,
  };
  for (let cell = 0; cell < cells; cell++) {
    if (!stepBehind(walk, graph.points, reachableFrom, laneAxis)) return null;
  }
  return { walk, reachableFrom };
}

export function behindChain(
  graph: RetreatGraph,
  fromPointName: string,
  laneAxis: LaneAxis = 'y',
): string[] {
  const start = graph.points.find((point) => point.name === fromPointName);
  if (!start) return [];

  const reachableFrom = traversableTargets(graph.paths);
  const walk: Walk = {
    cells: [],
    visited: new Set([start.name]),
    current: start,
  };
  while (stepBehind(walk, graph.points, reachableFrom, laneAxis)) {
    continue;
  }
  return walk.cells;
}

export function resolveRetreatPath(
  graph: RetreatGraph,
  dropPointName: string,
  cells: number = DROPOFF_RETREAT_CELLS,
  laneAxis: LaneAxis = 'y',
): string[] | null {
  return walkBehind(graph, dropPointName, cells, laneAxis)?.walk.cells ?? null;
}

export function resolveRetreatPlan(
  graph: RetreatGraph,
  dropPointName: string,
  laneAxisPointNames: ReadonlySet<string>,
  occupiedPointNames: ReadonlySet<string>,
  cells: number = DROPOFF_RETREAT_CELLS,
  laneAxis: LaneAxis = 'y',
): RetreatPlan | null {
  const walked = walkBehind(graph, dropPointName, cells, laneAxis);
  if (!walked) return null;

  const { walk, reachableFrom } = walked;
  const pointByName = new Map(
    graph.points.map((point) => [point.name, point] as const),
  );

  while (laneAxisPointNames.has(walk.current.name)) {
    const turn = turnOffEveryLaneFrom(
      walk.current,
      pointByName,
      reachableFrom,
      laneAxisPointNames,
      occupiedPointNames,
      laneAxis,
    );
    if (turn) return { cells: walk.cells, egress: turn };
    if (!stepBehind(walk, graph.points, reachableFrom, laneAxis)) return null;
  }
  return { cells: walk.cells, egress: null };
}
