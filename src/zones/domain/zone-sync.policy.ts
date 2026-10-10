import { pointNameOf } from './location-naming';

export type SyncStatus = 'ACTIVE' | 'STALE';

export interface SyncCandidate {
  readonly id: string;
  readonly status: SyncStatus;
  readonly memberLocationNames: readonly string[];
}

export interface KernelShape {
  readonly pointNames: ReadonlySet<string>;
  readonly locationLinks: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface SyncPlan {
  readonly desiredStatus: ReadonlyMap<string, SyncStatus>;
  readonly rebuildIds: ReadonlySet<string>;
}

export function planZoneSync(
  zones: readonly SyncCandidate[],
  kernel: KernelShape,
): SyncPlan {
  const repairable = zones.filter(
    (zone) => zone.status === 'ACTIVE' && standsOnRealPoints(zone, kernel),
  );
  const conflicted = zonesSharingALocation(repairable);
  const winners = repairable.filter((zone) => !conflicted.has(zone.id));

  const desiredStatus = new Map<string, SyncStatus>(
    zones.map((zone) => [zone.id, 'STALE']),
  );
  const rebuildIds = new Set<string>();
  for (const zone of winners) {
    desiredStatus.set(zone.id, 'ACTIVE');
    if (!kernelMatchesZone(zone, kernel)) rebuildIds.add(zone.id);
  }

  return { desiredStatus, rebuildIds };
}

export function withRebuildsFailed(plan: SyncPlan): SyncPlan {
  const desiredStatus = new Map(plan.desiredStatus);
  for (const id of plan.rebuildIds) desiredStatus.set(id, 'STALE');
  return { desiredStatus, rebuildIds: plan.rebuildIds };
}

function standsOnRealPoints(zone: SyncCandidate, kernel: KernelShape): boolean {
  if (zone.memberLocationNames.length === 0) return false;
  return zone.memberLocationNames.every((locationName) =>
    kernel.pointNames.has(pointNameOf(locationName)),
  );
}

function kernelMatchesZone(zone: SyncCandidate, kernel: KernelShape): boolean {
  return zone.memberLocationNames.every((locationName) => {
    const links = kernel.locationLinks.get(locationName);
    if (!links) return false;
    const pointName = pointNameOf(locationName);
    return kernel.pointNames.has(pointName) && links.has(pointName);
  });
}

function zonesSharingALocation(
  zones: readonly SyncCandidate[],
): ReadonlySet<string> {
  const claimants = new Map<string, string[]>();
  for (const zone of zones) {
    for (const locationName of zone.memberLocationNames) {
      const list = claimants.get(locationName) ?? [];
      list.push(zone.id);
      claimants.set(locationName, list);
    }
  }

  const conflicted = new Set<string>();
  for (const ids of claimants.values()) {
    if (ids.length > 1) for (const id of ids) conflicted.add(id);
  }
  return conflicted;
}
