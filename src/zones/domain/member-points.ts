import { pointNameOf } from './location-naming';

export interface PlantLocation {
  name?: string;
  links?: unknown;
}

function firstLinkedPoint(links: unknown): string | null {
  if (Array.isArray(links)) {
    const first = links[0] as Record<string, unknown> | undefined;
    if (!first) return null;
    if (typeof first.pointName === 'string') return first.pointName;
    if (typeof first.point === 'string') return first.point;
    return null;
  }
  if (links && typeof links === 'object') {
    return Object.keys(links)[0] ?? null;
  }
  return null;
}

export function resolveLocationPoints(
  locations: readonly PlantLocation[],
  locationNames: readonly string[],
): Map<string, string> {
  const linkedPoint = new Map<string, string>();
  for (const location of locations) {
    if (typeof location.name !== 'string') continue;
    const point = firstLinkedPoint(location.links);
    if (point) linkedPoint.set(location.name, point);
  }

  const resolved = new Map<string, string>();
  for (const locationName of locationNames) {
    resolved.set(
      locationName,
      linkedPoint.get(locationName) ?? pointNameOf(locationName),
    );
  }
  return resolved;
}
