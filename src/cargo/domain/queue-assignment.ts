export interface QueueSeat {
  readonly reserved: string | null;
}

export interface SeatedVehicle<T> {
  readonly entry: T;
  readonly target: string | null;
}

export function seatTheQueue<T extends QueueSeat>(
  chain: readonly string[],
  waiting: readonly T[],
  heldElsewhere: ReadonlySet<string>,
): SeatedVehicle<T>[] {
  const free = chain.filter((cell) => !heldElsewhere.has(cell));
  const keeping = new Map<T, string>();
  const kept = new Set<string>();

  for (const entry of waiting) {
    const stillValid =
      entry.reserved !== null &&
      free.includes(entry.reserved) &&
      !kept.has(entry.reserved);
    if (stillValid) {
      keeping.set(entry, entry.reserved);
      kept.add(entry.reserved);
    }
  }

  const spare = free.filter((cell) => !kept.has(cell));
  let next = 0;
  return waiting.map((entry) => ({
    entry,
    target: keeping.get(entry) ?? spare[next++] ?? null,
  }));
}
