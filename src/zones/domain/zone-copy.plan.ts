import { pointNameOf } from './location-naming';

export interface CopySource {
  id: string;
  name: string;
  memberLocationNames: readonly string[];
}

export interface CopySkip {
  sourceId: string;
  name: string;
  reason: string;
}

export interface CopyTarget {
  /** Point names of the map the zones are copied onto. */
  pointNames: ReadonlySet<string>;
  /** Zone names already used on the target map. */
  takenNames: ReadonlySet<string>;
  /** Member locations already held by an ACTIVE zone on the target map. */
  takenLocations: ReadonlySet<string>;
  /** Extra per-zone check (e.g. drop-off reachability); returns a reason to skip, or null. */
  extraProblem?: (source: CopySource) => string | null;
}

export interface CopyPlan<T extends CopySource> {
  accepted: T[];
  skipped: CopySkip[];
}

/**
 * Decides which zones of a source map can be recreated on the target map. A zone is copied only
 * when every member point exists on the target map and neither its name nor any of its locations
 * collides with the target map — or with a zone accepted earlier in the same batch.
 */
export function planZoneCopy<T extends CopySource>(
  sources: readonly T[],
  target: CopyTarget,
): CopyPlan<T> {
  const takenNames = new Set(target.takenNames);
  const takenLocations = new Set(target.takenLocations);
  const accepted: T[] = [];
  const skipped: CopySkip[] = [];
  const skip = (source: T, reason: string) =>
    skipped.push({ sourceId: source.id, name: source.name, reason });

  for (const source of sources) {
    if (source.memberLocationNames.length === 0) {
      skip(source, 'Khu vực không có vị trí nào.');
      continue;
    }
    const missing = source.memberLocationNames
      .map(pointNameOf)
      .filter((pointName) => !target.pointNames.has(pointName));
    if (missing.length > 0) {
      skip(
        source,
        `Bản đồ đích không có điểm: ${[...new Set(missing)].join(', ')}.`,
      );
      continue;
    }
    if (takenNames.has(source.name)) {
      skip(source, `Tên "${source.name}" đã tồn tại trên bản đồ đích.`);
      continue;
    }
    const clashing = source.memberLocationNames.filter((name) =>
      takenLocations.has(name),
    );
    if (clashing.length > 0) {
      skip(
        source,
        `Vị trí đã thuộc khu vực khác trên bản đồ đích: ${clashing.join(', ')}.`,
      );
      continue;
    }
    const problem = target.extraProblem?.(source) ?? null;
    if (problem) {
      skip(source, problem);
      continue;
    }

    accepted.push(source);
    takenNames.add(source.name);
    for (const name of source.memberLocationNames) takenLocations.add(name);
  }

  return { accepted, skipped };
}
