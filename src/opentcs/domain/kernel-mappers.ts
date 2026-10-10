import type {
  KernelLocation,
  KernelLocationLink,
  KernelLocationType,
  KernelPath,
  KernelLayoutProperty,
  KernelPlantModel,
  KernelPoint,
  KernelTransportOrder,
  KernelTransportOrderDebug,
  KernelVehicleGoal,
  KernelVehiclePrecisePosition,
  KernelVehicleState,
  KernelVisualLayout,
} from './kernel-model';
import { toVehicleErrors } from './vehicle-errors';

const PARKING_PRIORITY_KEY = 'tcs:parkingPositionPriority';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function mapArray<T>(value: unknown, map: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<T[]>((items, item) => {
    const mapped = map(item);
    if (mapped !== null) items.push(mapped);
    return items;
  }, []);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toOrientationAngle(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toPrecisePosition(
  value: unknown,
): KernelVehiclePrecisePosition | null {
  if (!isRecord(value)) return null;
  const { x, y, z } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    return null;
  }
  return { x, y, z };
}

export function toAllocatedResources(value: unknown): string[][] {
  return mapArray(value, (group) =>
    Array.isArray(group)
      ? group.filter((item): item is string => typeof item === 'string')
      : null,
  );
}

export function loadedFromHandlingDevices(value: unknown): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.some((device) => isRecord(device) && device.full === true);
}

export function unwrapEnumValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'timestamp') continue;
      if (typeof inner === 'string') return inner;
    }
  }
  return undefined;
}

export function orientationAngleFromSsePose(pose: unknown): number | null {
  return isRecord(pose) ? toOrientationAngle(pose.orientationAngle) : null;
}

export function precisePositionFromSsePose(
  pose: unknown,
): KernelVehiclePrecisePosition | null {
  return isRecord(pose) ? toPrecisePosition(pose.position) : null;
}

/**
 * Read `tcs:parkingPositionPriority` from a point's properties. openTCS serves
 * properties as an array of {key,value} over REST (the plant-model channel), but
 * an object map over SSE — accept either. Returns null when unset or unparseable.
 */
function parkingPriority(props: unknown): number | null {
  let raw: unknown;
  if (Array.isArray(props)) {
    const found = props.find(
      (p): p is { key: string; value: unknown } =>
        isRecord(p) && p.key === PARKING_PRIORITY_KEY,
    );
    raw = found?.value;
  } else if (isRecord(props)) {
    raw = props[PARKING_PRIORITY_KEY];
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toKernelPoint(value: unknown): KernelPoint | null {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }

  const position = isRecord(value.position) ? value.position : {};
  return {
    name: value.name,
    type: typeof value.type === 'string' ? value.type : '',
    position: {
      x: typeof position.x === 'number' ? position.x : 0,
      y: typeof position.y === 'number' ? position.y : 0,
    },
    parkingPriority: parkingPriority(value.properties),
  };
}

function toKernelPath(value: unknown): KernelPath | null {
  if (!isRecord(value)) {
    return null;
  }

  const { srcPointName, destPointName, maxVelocity, maxReverseVelocity } =
    value;
  if (typeof srcPointName !== 'string' || typeof destPointName !== 'string') {
    return null;
  }
  if (
    typeof maxVelocity !== 'number' ||
    typeof maxReverseVelocity !== 'number'
  ) {
    return null;
  }

  return {
    srcPointName,
    destPointName,
    length: typeof value.length === 'number' ? value.length : 0,
    maxVelocity,
    maxReverseVelocity,
    locked: value.locked === true,
  };
}

function toKernelLocationType(value: unknown): KernelLocationType | null {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }

  return {
    name: value.name,
    allowedOperations: toStringArray(value.allowedOperations),
  };
}

function toKernelLocationLink(value: unknown): KernelLocationLink | null {
  if (!isRecord(value)) {
    return null;
  }

  const pointName =
    typeof value.pointName === 'string' ? value.pointName : undefined;
  const point = typeof value.point === 'string' ? value.point : undefined;
  return pointName || point ? { pointName, point } : null;
}

function toKernelLocation(value: unknown): KernelLocation | null {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }

  const links = Array.isArray(value.links)
    ? mapArray(value.links, toKernelLocationLink)
    : isRecord(value.links)
      ? value.links
      : undefined;

  return {
    name: value.name,
    typeName: typeof value.typeName === 'string' ? value.typeName : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    links,
  };
}

export function locationPointNames(links: KernelLocation['links']): string[] {
  if (Array.isArray(links)) {
    return links.reduce<string[]>((points, link) => {
      const point = link.pointName ?? link.point;
      if (typeof point === 'string') points.push(point);
      return points;
    }, []);
  }
  if (isRecord(links)) return Object.keys(links);
  return [];
}

function toKernelLayoutProperty(value: unknown): KernelLayoutProperty | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== 'string' || typeof value.value !== 'string') {
    return null;
  }
  return { name: value.name, value: value.value };
}

function toKernelVisualLayout(value: unknown): KernelVisualLayout | null {
  if (!isRecord(value)) return null;
  return { properties: mapArray(value.properties, toKernelLayoutProperty) };
}

export function toKernelPlantModel(value: unknown): KernelPlantModel | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    points: mapArray(value.points, toKernelPoint),
    paths: mapArray(value.paths, toKernelPath),
    locationTypes: mapArray(value.locationTypes, toKernelLocationType),
    locations: mapArray(value.locations, toKernelLocation),
    visualLayout: toKernelVisualLayout(value.visualLayout),
  };
}

/**
 * Entries the kernel reported in a shape the mapper cannot use, as ready-to-log
 * phrases (`['2 point(s)']`). Empty when nothing was dropped.
 */
export function unusablePlantModelEntries(
  raw: unknown,
  view: KernelPlantModel,
): string[] {
  if (!isRecord(raw)) return [];

  const dropped: string[] = [];
  const compare = (kind: string, rawValue: unknown, kept: number): void => {
    const total = Array.isArray(rawValue) ? rawValue.length : 0;
    if (total > kept) dropped.push(`${total - kept} ${kind}`);
  };
  compare('point(s)', raw.points, view.points.length);
  compare('path(s)', raw.paths, view.paths.length);
  compare('location(s)', raw.locations, view.locations.length);
  return dropped;
}

export function toKernelVehicleState(
  value: unknown,
): KernelVehicleState | null {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }

  const properties = toVehicleProperties(value.properties);

  return {
    name: value.name,
    state:
      value.state === 'UNKNOWN' ||
      value.state === 'UNAVAILABLE' ||
      value.state === 'ERROR' ||
      value.state === 'IDLE' ||
      value.state === 'EXECUTING' ||
      value.state === 'CHARGING'
        ? value.state
        : 'UNKNOWN',
    procState:
      value.procState === 'UNAVAILABLE' ||
      value.procState === 'IDLE' ||
      value.procState === 'AWAITING_ORDER' ||
      value.procState === 'PROCESSING_ORDER'
        ? value.procState
        : 'UNAVAILABLE',
    integrationLevel:
      value.integrationLevel === 'TO_BE_IGNORED' ||
      value.integrationLevel === 'TO_BE_NOTICED' ||
      value.integrationLevel === 'TO_BE_RESPECTED' ||
      value.integrationLevel === 'TO_BE_UTILIZED'
        ? value.integrationLevel
        : 'TO_BE_IGNORED',
    energyLevel: typeof value.energyLevel === 'number' ? value.energyLevel : 0,
    paused: typeof value.paused === 'boolean' ? value.paused : false,
    currentPosition:
      typeof value.currentPosition === 'string' ? value.currentPosition : null,
    precisePosition: toPrecisePosition(value.precisePosition),
    orientationAngle: toOrientationAngle(value.orientationAngle),
    allocatedResources: toAllocatedResources(value.allocatedResources),
    transportOrder:
      typeof value.transportOrder === 'string' ? value.transportOrder : null,
    properties,
    errors: toVehicleErrors(properties),
  };
}

export function toVehicleProperties(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function destinationLocationNames(value: unknown): string[] {
  return mapArray(value, (destination) =>
    isRecord(destination) && typeof destination.locationName === 'string'
      ? destination.locationName
      : null,
  );
}

export function toKernelTransportOrder(
  value: unknown,
): KernelTransportOrder | null {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }

  return {
    name: value.name,
    state: typeof value.state === 'string' ? value.state : 'UNKNOWN',
    intendedVehicle:
      typeof value.intendedVehicle === 'string' ? value.intendedVehicle : null,
    processingVehicle:
      typeof value.processingVehicle === 'string'
        ? value.processingVehicle
        : null,
    destinations: destinationLocationNames(value.destinations),
  };
}

export function toKernelTransportOrders(
  value: unknown,
): KernelTransportOrder[] {
  return mapArray(value, toKernelTransportOrder);
}

export function toKernelVehicleStates(value: unknown): KernelVehicleState[] {
  return mapArray(value, toKernelVehicleState);
}

export function toTransportOrderDebug(
  value: unknown,
): KernelTransportOrderDebug | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    name: typeof value.name === 'string' ? value.name : undefined,
    state: typeof value.state === 'string' ? value.state : undefined,
    intendedVehicle:
      typeof value.intendedVehicle === 'string'
        ? value.intendedVehicle
        : undefined,
    processingVehicle:
      typeof value.processingVehicle === 'string'
        ? value.processingVehicle
        : undefined,
    destinations: value.destinations,
  };
}

export function toTransportOrderDebugList(
  value: unknown,
): KernelTransportOrderDebug[] {
  return mapArray(value, toTransportOrderDebug);
}

const SETTLED_ORDER_STATES = new Set([
  'FINISHED',
  'FAILED',
  'UNROUTABLE',
  'WITHDRAWN',
]);

export interface VehicleGoalUpdate {
  vehicleName: string;
  goal: KernelVehicleGoal | null;
}

type PendingDestination = Omit<KernelVehicleGoal, 'orderName'>;

function creationTimeOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = isRecord(value.creationTime)
    ? value.creationTime.creationTime
    : value.creationTime;
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
    return undefined;
  }
  return raw;
}

function unfinished(value: unknown, from: number): unknown[] {
  if (!Array.isArray(value)) return [];
  return from > 0 ? value.slice(from) : value;
}

function toPendingDestination(
  destinationName: unknown,
  operation: unknown,
): PendingDestination | null {
  if (typeof destinationName !== 'string') return null;
  return {
    destinationName,
    operation: unwrapEnumValue(operation) ?? '',
  };
}

function pendingDriveOrder(
  driveOrders: unknown,
  currentIndex: unknown,
): PendingDestination | null {
  const from = typeof currentIndex === 'number' ? currentIndex : 0;
  for (const driveOrder of unfinished(driveOrders, from)) {
    if (!isRecord(driveOrder)) continue;
    if (unwrapEnumValue(driveOrder.state) === 'FINISHED') continue;
    const destination = driveOrder.destination;
    if (!isRecord(destination)) continue;
    const pending = toPendingDestination(
      destination.destination ?? destination.locationName,
      destination.operation,
    );
    if (pending) return pending;
  }
  return null;
}

function pendingDestination(destinations: unknown): PendingDestination | null {
  if (!Array.isArray(destinations)) return null;
  for (const destination of destinations) {
    if (!isRecord(destination)) continue;
    if (unwrapEnumValue(destination.state) === 'FINISHED') continue;
    const pending = toPendingDestination(
      destination.locationName,
      destination.operation,
    );
    if (pending) return pending;
  }
  return null;
}

export function toVehicleGoal(value: unknown): VehicleGoalUpdate | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;

  const vehicleName =
    unwrapEnumValue(value.processingVehicle) ??
    unwrapEnumValue(value.processingVehicleName);
  if (!vehicleName) return null;

  const settled = SETTLED_ORDER_STATES.has(unwrapEnumValue(value.state) ?? '');
  const destination = settled
    ? null
    : (pendingDriveOrder(value.driveOrders, value.currentDriveOrderIndex) ??
      pendingDestination(value.destinations));

  return {
    vehicleName,
    goal: destination
      ? {
          orderName: value.name,
          ...destination,
          ...(creationTimeOf(value) && {
            creationTime: creationTimeOf(value),
          }),
        }
      : null,
  };
}
