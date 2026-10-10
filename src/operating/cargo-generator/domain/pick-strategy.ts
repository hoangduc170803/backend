export type FillMode = 'all' | 'column' | 'batch';

export interface PickLane {
  key: string;
  pointNames: readonly string[];
}

export interface PickCursor {
  laneKey: string | null;
  remaining: number;
}

export const INITIAL_CURSOR: PickCursor = { laneKey: null, remaining: 0 };

export type Random = () => number;

function pickOne<T>(items: readonly T[], random: Random): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

function freeIn(lane: PickLane, free: ReadonlySet<string>): string[] {
  return lane.pointNames.filter((name) => free.has(name));
}

export function pickNext(
  mode: FillMode,
  lanes: readonly PickLane[],
  free: ReadonlySet<string>,
  cursor: PickCursor,
  batchSize: number,
  random: Random = Math.random,
): { point: string; cursor: PickCursor } | null {
  const lanesWithRoom = lanes.filter((lane) => freeIn(lane, free).length > 0);
  if (lanesWithRoom.length === 0) return null;

  if (mode === 'all') {
    const point = pickOne(
      lanesWithRoom.flatMap((lane) => freeIn(lane, free)),
      random,
    );
    return { point, cursor: INITIAL_CURSOR };
  }

  const current = lanesWithRoom.find((lane) => lane.key === cursor.laneKey);
  const keepCurrent =
    current !== undefined && (mode === 'column' || cursor.remaining > 0);
  const lane = keepCurrent ? current : pickOne(lanesWithRoom, random);
  const owed = keepCurrent ? cursor.remaining : Math.max(1, batchSize);
  return {
    point: pickOne(freeIn(lane, free), random),
    cursor: {
      laneKey: lane.key,
      remaining: mode === 'batch' ? owed - 1 : 0,
    },
  };
}
