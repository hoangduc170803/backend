const PATH_RESOURCE_SEPARATOR = ' --- ';

export interface LaneSlot {
  readonly laneKey: number;
  readonly depthKey: number;
}

export function isPathResource(resource: string): boolean {
  return resource.includes(PATH_RESOURCE_SEPARATOR);
}

export function allocatedPointNames(
  resources: readonly (readonly string[])[],
): string[] {
  return resources.flat().filter((resource) => !isPathResource(resource));
}

export function allocationReachesPoints(
  resources: readonly (readonly string[])[],
  points: ReadonlySet<string>,
): boolean {
  return allocatedPointNames(resources).some((point) => points.has(point));
}

export function isDeeperInSameLane(
  slot: LaneSlot,
  reference: LaneSlot,
): boolean {
  return (
    slot.laneKey === reference.laneKey && slot.depthKey > reference.depthKey
  );
}
