export const ALIGNMENT_TOLERANCE_MM = 100;

export type Axis = 'x' | 'y';

export interface PointPosition {
  x: number;
  y: number;
}

export interface PositionedPoint {
  name: string;
  position: PointPosition;
}

export interface AxisShift {
  readonly axis: Axis;
  readonly from: number;
  readonly to: number;
  readonly pointNames: readonly string[];
}

export interface PointAlignment<T extends PositionedPoint> {
  readonly points: T[];
  readonly shifts: readonly AxisShift[];
}

export function alignPoints<T extends PositionedPoint>(
  points: readonly T[],
  toleranceMm: number = ALIGNMENT_TOLERANCE_MM,
): PointAlignment<T> {
  if (toleranceMm <= 0 || points.length === 0) {
    return { points: [...points], shifts: [] };
  }

  const shifts: AxisShift[] = [];
  const replacement: Record<Axis, Map<number, number>> = {
    x: representativeByValue(points, 'x', toleranceMm),
    y: representativeByValue(points, 'y', toleranceMm),
  };

  for (const axis of ['x', 'y'] as const) {
    for (const [from, to] of replacement[axis]) {
      if (from === to) continue;
      shifts.push({
        axis,
        from,
        to,
        pointNames: points
          .filter((point) => point.position[axis] === from)
          .map((point) => point.name)
          .sort(),
      });
    }
  }

  const aligned = points.map((point) => ({
    ...point,
    position: {
      ...point.position,
      x: replacement.x.get(point.position.x) ?? point.position.x,
      y: replacement.y.get(point.position.y) ?? point.position.y,
    },
  }));

  return { points: aligned, shifts };
}

export function describeShift(shift: AxisShift): string {
  const names = shift.pointNames.join(', ');
  return `${shift.axis}=${shift.from} → ${shift.to} (${shift.to - shift.from > 0 ? '+' : ''}${shift.to - shift.from}mm): ${names}`;
}

function representativeByValue<T extends PositionedPoint>(
  points: readonly T[],
  axis: Axis,
  toleranceMm: number,
): Map<number, number> {
  const countByValue = new Map<number, number>();
  for (const point of points) {
    const value = point.position[axis];
    countByValue.set(value, (countByValue.get(value) ?? 0) + 1);
  }

  const replacement = new Map<number, number>();
  for (const cluster of clusters([...countByValue.keys()], toleranceMm)) {
    const representative = mostPopulated(cluster, countByValue);
    for (const value of cluster) replacement.set(value, representative);
  }
  return replacement;
}

function clusters(values: number[], toleranceMm: number): number[][] {
  const sorted = [...values].sort((a, b) => a - b);
  const grouped: number[][] = [];
  for (const value of sorted) {
    const current = grouped[grouped.length - 1];
    if (current && value - current[0] <= toleranceMm) current.push(value);
    else grouped.push([value]);
  }
  return grouped;
}

function mostPopulated(
  cluster: readonly number[],
  countByValue: ReadonlyMap<number, number>,
): number {
  return cluster.reduce((best, value) => {
    const bestCount = countByValue.get(best) ?? 0;
    const count = countByValue.get(value) ?? 0;
    if (count > bestCount) return value;
    return count === bestCount && value < best ? value : best;
  }, cluster[0]);
}
