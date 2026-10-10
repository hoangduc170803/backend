export interface BackfillCandidate {
  id: string;
  lastLoadedAt: Date | null;
}

/**
 * Picks the single `map_records` row a legacy zone's `plant_model_name` should be backfilled
 * to. Two XML uploads can share a name, so a name match alone is never enough — this only
 * resolves when exactly one candidate, or exactly one *most-recently-loaded* candidate, exists.
 * Anything else (no candidate ever loaded, several tied) is left unresolved rather than guessed:
 * a wrong guess would silently misattribute the zone's geometry to the wrong map record.
 */
export function resolveBackfillMatch(
  candidates: readonly BackfillCandidate[],
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;

  const everLoaded = candidates.filter((c) => c.lastLoadedAt !== null);
  if (everLoaded.length === 0) return null;

  const [latest] = [...everLoaded].sort(
    (a, b) => b.lastLoadedAt!.getTime() - a.lastLoadedAt!.getTime(),
  );
  if (
    everLoaded.filter(
      (c) => c.lastLoadedAt!.getTime() === latest.lastLoadedAt!.getTime(),
    ).length !== 1
  )
    return null;
  return latest.id;
}
