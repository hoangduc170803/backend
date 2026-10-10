import type { PlantPath, TopologyPoint } from './zone-topology';

export const LAYOUT_DIRECTION_PROPERTY = 'direction';

const MAINLINE_SPAN_RATIO = 0.5;

export type LaneAxis = 'x' | 'y';

export interface LayoutProperty {
  readonly name: string;
  readonly value: string;
}

export interface Mainline {
  readonly axis: LaneAxis;
  readonly offset: number;
  readonly pointNames: readonly string[];
}

export interface LaneAxisResult {
  readonly axis: LaneAxis;
  readonly source: 'declared' | 'detected';
}

export function findMainlines(
  points: readonly TopologyPoint[],
  paths: readonly PlantPath[],
): Mainline[] {
  const running = axisWithTheLongestChain(points, paths);
  if (!running) return [];

  const extent = extentAlong(points, running);
  if (extent === 0) return [];

  return chainsAlong(points, paths, running)
    .reduce<Mainline[]>((mainlines, chain) => {
      if (spanAlong(chain, running) >= MAINLINE_SPAN_RATIO * extent) {
        mainlines.push(toMainline(chain, running));
      }
      return mainlines;
    }, [])
    .sort((a, b) => a.offset - b.offset);
}

export function mainlinePointNames(
  mainlines: readonly Mainline[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const mainline of mainlines) {
    for (const name of mainline.pointNames) names.add(name);
  }
  return names;
}

export function laneAxisOf(
  points: readonly TopologyPoint[],
  paths: readonly PlantPath[],
  layoutProperties: readonly LayoutProperty[],
): LaneAxisResult {
  const declared = layoutProperties.some(
    (property) => property.name === LAYOUT_DIRECTION_PROPERTY,
  );
  if (declared) return { axis: 'y', source: 'declared' };

  const running = axisWithTheLongestChain(points, paths);
  return { axis: running === 'x' ? 'y' : 'x', source: 'detected' };
}

export function alongLane(
  laneAxis: LaneAxis,
  position: TopologyPoint['position'],
): number {
  return laneAxis === 'x' ? position.x : position.y;
}

export function acrossLane(
  laneAxis: LaneAxis,
  position: TopologyPoint['position'],
): number {
  return laneAxis === 'x' ? position.y : position.x;
}

function axisWithTheLongestChain(
  points: readonly TopologyPoint[],
  paths: readonly PlantPath[],
): LaneAxis | null {
  let best: { axis: LaneAxis; ratio: number } | null = null;
  for (const axis of ['x', 'y'] as const) {
    const extent = extentAlong(points, axis);
    if (extent === 0) continue;
    const chains = chainsAlong(points, paths, axis);
    if (chains.length === 0) continue;
    const longest = Math.max(...chains.map((chain) => spanAlong(chain, axis)));
    const ratio = longest / extent;
    if (!best || ratio > best.ratio) best = { axis, ratio };
  }
  return best?.axis ?? null;
}

function chainsAlong(
  points: readonly TopologyPoint[],
  paths: readonly PlantPath[],
  axis: LaneAxis,
): TopologyPoint[][] {
  const byName = new Map(points.map((point) => [point.name, point]));
  const neighbours = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const known = neighbours.get(from);
    if (known) known.add(to);
    else neighbours.set(from, new Set([to]));
  };

  for (const path of paths) {
    if (path.maxVelocity <= 0 && path.maxReverseVelocity <= 0) continue;
    const src = path.srcPointName && byName.get(path.srcPointName);
    const dest = path.destPointName && byName.get(path.destPointName);
    if (!src || !dest) continue;
    if (!runsAlong(axis, src, dest)) continue;
    link(src.name, dest.name);
    link(dest.name, src.name);
  }

  const seen = new Set<string>();
  const chains: TopologyPoint[][] = [];
  for (const name of [...neighbours.keys()].sort()) {
    if (seen.has(name)) continue;
    const stack = [name];
    const chain: TopologyPoint[] = [];
    while (stack.length) {
      const here = stack.pop() as string;
      if (seen.has(here)) continue;
      seen.add(here);
      const point = byName.get(here);
      if (point) chain.push(point);
      for (const next of neighbours.get(here) ?? []) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    chains.push(chain);
  }
  return chains;
}

function runsAlong(
  axis: LaneAxis,
  from: TopologyPoint,
  to: TopologyPoint,
): boolean {
  const dx = Math.abs(to.position.x - from.position.x);
  const dy = Math.abs(to.position.y - from.position.y);
  return axis === 'x' ? dx > dy : dy > dx;
}

function coordinateAlong(axis: LaneAxis, point: TopologyPoint): number {
  return axis === 'x' ? point.position.x : point.position.y;
}

function extentAlong(points: readonly TopologyPoint[], axis: LaneAxis): number {
  if (points.length === 0) return 0;
  const values = points.map((point) => coordinateAlong(axis, point));
  return Math.max(...values) - Math.min(...values);
}

function spanAlong(chain: readonly TopologyPoint[], axis: LaneAxis): number {
  const values = chain.map((point) => coordinateAlong(axis, point));
  return Math.max(...values) - Math.min(...values);
}

function toMainline(chain: TopologyPoint[], axis: LaneAxis): Mainline {
  const ordered = [...chain].sort(
    (a, b) => coordinateAlong(axis, a) - coordinateAlong(axis, b),
  );
  const across: LaneAxis = axis === 'x' ? 'y' : 'x';
  return {
    axis,
    offset: coordinateAlong(across, ordered[0]),
    pointNames: ordered.map((point) => point.name),
  };
}
