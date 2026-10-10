const NOISE_FLOOR = 100;

export interface PointCoords {
  x: number;
  y: number;
}

export interface BoundaryEdge {
  outside: PointCoords;
  inside: PointCoords;
  enterable: boolean;
}

export interface MemberAxes {
  depthKey: number;
  laneKey: number;
}

export interface ZoneAxes {
  aisleCenter: PointCoords;
  depth: PointCoords;
  lane: PointCoords;
}

function directionKey(edge: BoundaryEdge): string {
  const vx = edge.inside.x - edge.outside.x;
  const vy = edge.inside.y - edge.outside.y;
  const length = Math.hypot(vx, vy) || 1;
  return `${(vx / length).toFixed(3)},${(vy / length).toFixed(3)}`;
}

export function dominantDirection(
  edges: readonly BoundaryEdge[],
): BoundaryEdge[] {
  const byDirection = new Map<string, BoundaryEdge[]>();
  for (const edge of edges) {
    const key = directionKey(edge);
    byDirection.set(key, [...(byDirection.get(key) ?? []), edge]);
  }
  return [...byDirection.entries()].sort(
    ([keyA, a], [keyB, b]) => b.length - a.length || keyA.localeCompare(keyB),
  )[0][1];
}

export function wayIntoZone(
  boundary: readonly BoundaryEdge[],
): BoundaryEdge[] | null {
  if (boundary.length === 0) return null;
  const enterable = boundary.filter((edge) => edge.enterable);
  return dominantDirection(enterable.length > 0 ? enterable : boundary);
}

export function axesOf(wayIn: readonly BoundaryEdge[]): ZoneAxes {
  const aisleCenter: PointCoords = {
    x: wayIn.reduce((sum, edge) => sum + edge.outside.x, 0) / wayIn.length,
    y: wayIn.reduce((sum, edge) => sum + edge.outside.y, 0) / wayIn.length,
  };

  const dirX = wayIn.reduce(
    (sum, edge) => sum + edge.inside.x - edge.outside.x,
    0,
  );
  const dirY = wayIn.reduce(
    (sum, edge) => sum + edge.inside.y - edge.outside.y,
    0,
  );
  const length = Math.hypot(dirX, dirY) || 1;
  const depth: PointCoords = { x: dirX / length, y: dirY / length };

  return { aisleCenter, depth, lane: { x: -depth.y, y: depth.x } };
}

export function projectOnto(
  axes: ZoneAxes,
  coords: PointCoords,
): { depth: number; lane: number } {
  const relX = coords.x - axes.aisleCenter.x;
  const relY = coords.y - axes.aisleCenter.y;
  return {
    depth: relX * axes.depth.x + relY * axes.depth.y,
    lane: relX * axes.lane.x + relY * axes.lane.y,
  };
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
