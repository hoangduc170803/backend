export const EPOCH_ENTITY_PREFIX = 'WES-KERNEL-EPOCH-';
export const EPOCH_PROPERTY = 'wes:kernelEpoch';

const FAR_AWAY_MM = -100_000_000;
const HALF_SIDE_MM = 5;

export function epochEntityName(epoch: string): string {
  return `${EPOCH_ENTITY_PREFIX}${epoch}`;
}

export function epochEntityBody(epoch: string): Record<string, unknown> {
  const corners = [
    { x: -HALF_SIDE_MM, y: -HALF_SIDE_MM },
    { x: HALF_SIDE_MM, y: -HALF_SIDE_MM },
    { x: HALF_SIDE_MM, y: HALF_SIDE_MM },
    { x: -HALF_SIDE_MM, y: HALF_SIDE_MM },
  ];
  return {
    envelope: { vertices: [...corners, { ...corners[0] }] },
    pose: {
      position: { x: FAR_AWAY_MM, y: FAR_AWAY_MM, z: 0 },
      orientationAngle: 0,
    },
    type: 'OBJECT',
    integrationLevel: 'TO_BE_IGNORED',
    layout: { layerId: 0 },
    incompleteName: false,
    properties: { [EPOCH_PROPERTY]: epoch },
  };
}

interface EpochCandidate {
  name?: unknown;
  retired?: unknown;
  properties?: unknown;
}

export function liveEpochOf(entities: readonly unknown[]): string | null {
  for (const raw of entities) {
    const entity = (raw ?? {}) as EpochCandidate;
    if (typeof entity.name !== 'string') continue;
    if (!entity.name.startsWith(EPOCH_ENTITY_PREFIX)) continue;
    if (entity.retired === true) continue;
    const epoch = propertyOf(entity.properties, EPOCH_PROPERTY);
    if (epoch) return epoch;
  }
  return null;
}

export function liveEpochNames(entities: readonly unknown[]): string[] {
  return entities
    .map((raw) => (raw ?? {}) as EpochCandidate)
    .filter(
      (entity): entity is { name: string } & EpochCandidate =>
        typeof entity.name === 'string' &&
        entity.name.startsWith(EPOCH_ENTITY_PREFIX) &&
        entity.retired !== true,
    )
    .map((entity) => entity.name);
}

function propertyOf(properties: unknown, key: string): string | null {
  if (Array.isArray(properties)) {
    const entry = (properties as { name?: unknown; value?: unknown }[]).find(
      (candidate) => candidate?.name === key,
    );
    return typeof entry?.value === 'string' ? entry.value : null;
  }
  if (properties && typeof properties === 'object') {
    const value = (properties as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }
  return null;
}
