import { acrossLane, alongLane, type LaneAxis } from './mainline';

export interface PlantPath {
  srcPointName?: string;
  destPointName?: string;
  maxVelocity: number;
  maxReverseVelocity: number;
}

interface Arc {
  readonly from: string;
  readonly to: string;
}

function directedArcs(paths: readonly PlantPath[]): Arc[] {
  const arcs: Arc[] = [];
  for (const path of paths) {
    const src = path.srcPointName;
    const dest = path.destPointName;
    if (!src || !dest) continue;
    if (path.maxVelocity > 0) arcs.push({ from: src, to: dest });
    if (path.maxReverseVelocity > 0) arcs.push({ from: dest, to: src });
  }
  return arcs;
}

function adjacency(arcs: readonly Arc[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const arc of arcs) {
    const list = adj.get(arc.from);
    if (list) list.push(arc.to);
    else adj.set(arc.from, [arc.to]);
  }
  return adj;
}

function bfs(
  adj: ReadonlyMap<string, string[]>,
  starts: readonly string[],
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const start of starts) {
    if (dist.has(start)) continue;
    dist.set(start, 0);
    queue.push(start);
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    const nodeDist = dist.get(node)!;
    for (const next of adj.get(node) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, nodeDist + 1);
      queue.push(next);
    }
  }
  return dist;
}

export function computeFeederPoints(
  paths: readonly PlantPath[],
  memberPointNames: ReadonlySet<string>,
): string[] {
  const feeders = new Set<string>();
  for (const arc of directedArcs(paths)) {
    const entersZone =
      memberPointNames.has(arc.to) && !memberPointNames.has(arc.from);
    if (entersZone) feeders.add(arc.to);
  }
  return [...feeders];
}

export function computeEgressPoints(
  paths: readonly PlantPath[],
  memberPointNames: ReadonlySet<string>,
): string[] {
  const egress = new Set<string>();
  for (const arc of directedArcs(paths)) {
    const leavesZone =
      memberPointNames.has(arc.from) && !memberPointNames.has(arc.to);
    if (leavesZone) egress.add(arc.to);
  }
  return [...egress];
}

export function hopsToExit(
  paths: readonly PlantPath[],
  memberPointNames: ReadonlySet<string>,
  egressPoints: readonly string[],
): Map<string, number> {
  const arcsTowardExit = directedArcs(paths).map((arc) => ({
    from: arc.to,
    to: arc.from,
  }));
  const dist = bfs(adjacency(arcsTowardExit), egressPoints);

  const hops = new Map<string, number>();
  for (const member of memberPointNames) {
    const d = dist.get(member);
    if (d != null) hops.set(member, d);
  }
  return hops;
}

export interface ReachabilityResult {
  feeders: string[];
  unreachable: string[];
  maxHops: number;
}

export function checkZoneReachability(
  paths: readonly PlantPath[],
  memberPointNames: ReadonlySet<string>,
): ReachabilityResult {
  const feeders = computeFeederPoints(paths, memberPointNames);
  const adj = adjacency(directedArcs(paths));

  const members = [...memberPointNames];
  const unreachable = new Set<string>();
  let maxHops = 0;

  for (const feeder of feeders) {
    const dist = bfs(adj, [feeder]);
    for (const member of members) {
      const d = dist.get(member);
      if (d == null) unreachable.add(member);
      else if (d > maxHops) maxHops = d;
    }
  }

  return { feeders, unreachable: [...unreachable], maxHops };
}

export interface TopologyPoint {
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number };
}

export interface LaneInvariantViolation {
  readonly code: 'V1' | 'V3';
  readonly detail: string;
}

function lanesOf(
  points: readonly TopologyPoint[],
  memberPointNames: ReadonlySet<string>,
  laneAxis: LaneAxis,
): TopologyPoint[][] {
  const byAxis = new Map<number, TopologyPoint[]>();
  for (const point of points) {
    if (!memberPointNames.has(point.name)) continue;
    const across = acrossLane(laneAxis, point.position);
    const lane = byAxis.get(across);
    if (lane) lane.push(point);
    else byAxis.set(across, [point]);
  }
  return [...byAxis.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, lane]) =>
      lane.sort(
        (a, b) =>
          alongLane(laneAxis, a.position) - alongLane(laneAxis, b.position),
      ),
    );
}

function nearestBehind(
  current: TopologyPoint,
  points: readonly TopologyPoint[],
  laneAxis: LaneAxis,
): TopologyPoint | null {
  let nearest: TopologyPoint | null = null;
  let nearestGap = Infinity;
  for (const candidate of points) {
    if (
      acrossLane(laneAxis, candidate.position) !==
      acrossLane(laneAxis, current.position)
    )
      continue;
    const gap =
      alongLane(laneAxis, candidate.position) -
      alongLane(laneAxis, current.position);
    if (gap <= 0 || gap >= nearestGap) continue;
    nearest = candidate;
    nearestGap = gap;
  }
  return nearest;
}

function corridorDepthAbove(
  shallowest: TopologyPoint,
  points: readonly TopologyPoint[],
  adj: ReadonlyMap<string, string[]>,
  laneAxis: LaneAxis,
): number {
  let current = shallowest;
  let depth = 0;
  for (let step = 0; step < 2; step++) {
    const behind = nearestBehind(current, points, laneAxis);
    if (!behind) return depth;
    if (!(adj.get(current.name) ?? []).includes(behind.name)) return depth;
    depth++;
    current = behind;
  }
  return depth;
}

export function checkLaneInvariants(
  points: readonly TopologyPoint[],
  paths: readonly PlantPath[],
  memberPointNames: ReadonlySet<string>,
  laneAxis: LaneAxis = 'y',
): LaneInvariantViolation[] {
  const arcs = directedArcs(paths);
  const adj = adjacency(arcs);
  const arcSet = new Set(arcs.map((arc) => `${arc.from}>${arc.to}`));
  const positionOf = new Map(
    points.map((point) => [point.name, point.position]),
  );
  const violations: LaneInvariantViolation[] = [];

  for (const lane of lanesOf(points, memberPointNames, laneAxis)) {
    const shallowest = lane[lane.length - 1];
    const depth = corridorDepthAbove(shallowest, points, adj, laneAxis);
    if (depth < 2) {
      violations.push({
        code: 'V1',
        detail: `lane x=${acrossLane(laneAxis, shallowest.position)} has only ${depth} corridor point(s) straight above ${shallowest.name}, needs 2`,
      });
    }
  }

  let direction = 0;
  for (const arc of arcs) {
    if (!memberPointNames.has(arc.from) || !memberPointNames.has(arc.to)) {
      continue;
    }
    const from = positionOf.get(arc.from);
    const to = positionOf.get(arc.to);
    if (!from || !to || acrossLane(laneAxis, from) === acrossLane(laneAxis, to))
      continue;

    if (arcSet.has(`${arc.to}>${arc.from}`)) {
      violations.push({
        code: 'V3',
        detail: `${arc.from} ↔ ${arc.to} crosses lanes in both directions`,
      });
      continue;
    }
    const sign = Math.sign(
      acrossLane(laneAxis, to) - acrossLane(laneAxis, from),
    );
    if (direction === 0) direction = sign;
    else if (direction !== sign) {
      violations.push({
        code: 'V3',
        detail: `${arc.from} → ${arc.to} crosses lanes against the other cross-lane paths`,
      });
    }
  }

  return violations;
}
