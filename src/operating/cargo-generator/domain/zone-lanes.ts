import type {
  PlantModelPathDto as PlantModelPath,
  PlantModelPointDto as PlantModelPoint,
} from '../../dto/operating.dto';

const NOISE_FLOOR = 100;

interface Coords {
  x: number;
  y: number;
}

interface BoundaryEdge {
  outside: Coords;
  inside: Coords;
  enterable: boolean;
}

export interface ZoneLane {
  key: number;
  pointNames: string[];
}

function directionKey(edge: BoundaryEdge): string {
  const vx = edge.inside.x - edge.outside.x;
  const vy = edge.inside.y - edge.outside.y;
  const length = Math.hypot(vx, vy) || 1;
  return `${(vx / length).toFixed(3)},${(vy / length).toFixed(3)}`;
}

function dominantDirection(edges: readonly BoundaryEdge[]): BoundaryEdge[] {
  const byDirection = new Map<string, BoundaryEdge[]>();
  for (const edge of edges) {
    const key = directionKey(edge);
    byDirection.set(key, [...(byDirection.get(key) ?? []), edge]);
  }
  return [...byDirection.entries()].sort(
    ([keyA, a], [keyB, b]) => b.length - a.length || keyA.localeCompare(keyB),
  )[0][1];
}

export function clusterKeys(values: readonly number[]): Map<number, number> {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  if (distinct.length === 0) return new Map();

  const gaps = distinct
    .slice(1)
    .map((value, index) => value - distinct[index])
    .filter((gap) => gap > NOISE_FLOOR);
  const threshold = gaps.length === 0 ? NOISE_FLOOR : Math.min(...gaps) / 2;

  const keys = new Map<number, number>();
  let group: number[] = [];
  const flush = (): void => {
    const centre = Math.round(
      group.reduce((sum, value) => sum + value, 0) / group.length,
    );
    for (const value of group) keys.set(value, centre);
  };
  for (const value of distinct) {
    if (group.length > 0 && value - group[group.length - 1] > threshold) {
      flush();
      group = [];
    }
    group.push(value);
  }
  if (group.length > 0) flush();
  return keys;
}

function boundaryEdges(
  paths: readonly PlantModelPath[],
  coords: ReadonlyMap<string, Coords>,
  inside: ReadonlySet<string>,
): BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];
  for (const path of paths) {
    const srcInside = inside.has(path.source);
    const destInside = inside.has(path.target);
    if (srcInside === destInside) continue;
    const outside = coords.get(srcInside ? path.target : path.source);
    const within = coords.get(srcInside ? path.source : path.target);
    if (!outside || !within) continue;
    edges.push({
      outside,
      inside: within,
      enterable: srcInside ? path.maxReverseVelocity > 0 : path.maxVelocity > 0,
    });
  }
  return edges;
}

type Projector = (c: Coords) => { depth: number; lane: number };

function projectorFromPaths(
  paths: readonly PlantModelPath[],
  coords: ReadonlyMap<string, Coords>,
  inside: ReadonlySet<string>,
): Projector | null {
  const boundary = boundaryEdges(paths, coords, inside);
  if (boundary.length === 0) return null;
  const enterable = boundary.filter((edge) => edge.enterable);
  const wayIn = dominantDirection(enterable.length > 0 ? enterable : boundary);

  const centre = {
    x: wayIn.reduce((sum, e) => sum + e.outside.x, 0) / wayIn.length,
    y: wayIn.reduce((sum, e) => sum + e.outside.y, 0) / wayIn.length,
  };
  const dirX = wayIn.reduce((sum, e) => sum + e.inside.x - e.outside.x, 0);
  const dirY = wayIn.reduce((sum, e) => sum + e.inside.y - e.outside.y, 0);
  const length = Math.hypot(dirX, dirY) || 1;
  const depth = { x: dirX / length, y: dirY / length };
  const lane = { x: -depth.y, y: depth.x };

  return (c) => {
    const relX = c.x - centre.x;
    const relY = c.y - centre.y;
    return {
      depth: relX * depth.x + relY * depth.y,
      lane: relX * lane.x + relY * lane.y,
    };
  };
}

function groupBy(
  names: readonly string[],
  coords: ReadonlyMap<string, Coords>,
  project: Projector,
): ZoneLane[] {
  const projected = names.flatMap((name) => {
    const c = coords.get(name);
    return c ? [{ name, ...project(c) }] : [];
  });
  const laneKeys = clusterKeys(projected.map((p) => p.lane));
  const lanes = new Map<number, { name: string; depth: number }[]>();
  for (const p of projected) {
    const key = laneKeys.get(p.lane) ?? 0;
    lanes.set(key, [...(lanes.get(key) ?? []), p]);
  }
  return [...lanes.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, members]) => ({
      key,
      pointNames: members.sort((a, b) => a.depth - b.depth).map((m) => m.name),
    }));
}

export function zoneLanes(
  pointNames: readonly string[],
  points: readonly PlantModelPoint[],
  paths: readonly PlantModelPath[],
): ZoneLane[] {
  const names = [...new Set(pointNames)];
  const coords = new Map<string, Coords>(
    points.map((p) => [p.name, { x: p.x, y: p.y }]),
  );
  const fromPaths = projectorFromPaths(paths, coords, new Set(names));
  if (fromPaths) return groupBy(names, coords, fromPaths);

  const byX = groupBy(names, coords, (c) => ({ depth: c.y, lane: c.x }));
  const byY = groupBy(names, coords, (c) => ({ depth: c.x, lane: c.y }));
  return byY.length < byX.length ? byY : byX;
}
