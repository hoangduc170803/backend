import {
  laneAxisOf,
  type LaneAxis,
  type LayoutProperty,
} from '../zones/domain/mainline';
import { ServiceUnavailableException } from '@nestjs/common';
import { KernelApiService } from './kernel-api.service';
import type { KernelPath } from './domain/kernel-model';

export type KernelLocationType = 'Pick up' | 'Drop off';

export interface MemberLocationSpec {
  locationName: string;
  pointName: string;
  type: KernelLocationType;
}

export interface TopologyPoint {
  name: string;
  position: { x: number; y: number };
}

export interface PlantTopology {
  name: string;
  pointNames: Set<string>;
  points: TopologyPoint[];
  locationLinks: Map<string, Set<string>>;
  paths: KernelPath[];
  laneAxis: LaneAxis;
}

interface LocationMeta {
  useTypeNameKey: 'typeName' | 'type';
  useArrayLinks: boolean;
  layout?: Record<string, unknown>;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function requireModel(rawModel: unknown): Record<string, unknown> {
  if (!rawModel || typeof rawModel !== 'object') {
    throw new ServiceUnavailableException(
      'Không thể kết nối hệ thống điều khiển.',
    );
  }
  return rawModel as Record<string, unknown>;
}

function extractLinkedPointNames(links: unknown): Set<string> {
  if (Array.isArray(links)) {
    return links.reduce<Set<string>>((names, link: unknown) => {
      if (!link || typeof link !== 'object') return names;
      const name =
        (link as { pointName?: unknown }).pointName ??
        (link as { point?: unknown }).point;
      if (typeof name === 'string') names.add(name);
      return names;
    }, new Set<string>());
  }
  if (links && typeof links === 'object') {
    return new Set(Object.keys(links));
  }
  return new Set();
}

function locationMetaFor(
  locations: Record<string, unknown>[],
  locationType: KernelLocationType,
): LocationMeta {
  const sample = locations.find(
    (location) => (location.typeName ?? location.type) === locationType,
  );
  return {
    useTypeNameKey: !sample || 'typeName' in sample ? 'typeName' : 'type',
    useArrayLinks: !sample || Array.isArray(sample.links),
    layout:
      sample?.layout && typeof sample.layout === 'object'
        ? { ...(sample.layout as Record<string, unknown>) }
        : undefined,
  };
}

function buildLocation(
  spec: MemberLocationSpec,
  points: Record<string, unknown>[],
  meta: LocationMeta,
): Record<string, unknown> {
  const point = points.find((candidate) => candidate.name === spec.pointName);
  const position = point?.position as Record<string, number> | undefined;
  const location: Record<string, unknown> = {
    name: spec.locationName,
    [meta.useTypeNameKey]: spec.type,
    position: { x: position?.x ?? 0, y: position?.y ?? 0, z: 0 },
    locked: false,
    links: meta.useArrayLinks
      ? [{ pointName: spec.pointName }]
      : { [spec.pointName]: [] },
  };
  if (meta.layout) location.layout = { ...meta.layout };
  return location;
}

function upsertInto(
  locations: Record<string, unknown>[],
  location: Record<string, unknown>,
): void {
  const index = locations.findIndex((item) => item.name === location.name);
  if (index >= 0) locations[index] = location;
  else locations.push(location);
}

export async function readPlantTopology(
  kernelApi: KernelApiService,
): Promise<PlantTopology | null> {
  const rawModel = await kernelApi.getRawPlantModel();
  if (!rawModel || typeof rawModel !== 'object') return null;

  const model = rawModel as Record<string, unknown>;
  const points = recordArray(model.points);
  const locations = recordArray(model.locations);
  const paths = recordArray(model.paths);
  const vehicles = recordArray(model.vehicles);
  const modelName = typeof model.name === 'string' ? model.name : null;
  if (modelName === null) return null;
  if (
    modelName === 'unnamed' &&
    points.length === 0 &&
    locations.length === 0 &&
    paths.length === 0 &&
    vehicles.length === 0
  ) {
    return null;
  }

  const pointNames = points.reduce((names, point) => {
    if (typeof point.name === 'string') names.add(point.name);
    return names;
  }, new Set<string>());

  const locationLinks = new Map<string, Set<string>>();
  for (const location of locations) {
    if (typeof location.name !== 'string') continue;
    locationLinks.set(location.name, extractLinkedPointNames(location.links));
  }

  return {
    name: modelName,
    pointNames,
    points: topologyPoints(points),
    locationLinks,
    paths: paths as unknown as KernelPath[],
    laneAxis: laneAxisOf(
      topologyPoints(points),
      paths as unknown as KernelPath[],
      layoutProperties(model.visualLayout),
    ).axis,
  };
}

function layoutProperties(value: unknown): LayoutProperty[] {
  if (!value || typeof value !== 'object') return [];
  const properties = (value as Record<string, unknown>).properties;
  if (!Array.isArray(properties)) return [];
  return properties.filter(
    (property): property is LayoutProperty =>
      !!property &&
      typeof property === 'object' &&
      typeof (property as LayoutProperty).name === 'string' &&
      typeof (property as LayoutProperty).value === 'string',
  );
}

function topologyPoints(
  points: readonly Record<string, unknown>[],
): TopologyPoint[] {
  const resolved: TopologyPoint[] = [];
  for (const point of points) {
    if (typeof point.name !== 'string') continue;
    const pose = point.pose as Record<string, unknown> | undefined;
    const position = (pose?.position ?? point.position) as
      | Record<string, unknown>
      | undefined;
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    resolved.push({ name: point.name, position: { x, y } });
  }
  return resolved;
}

export function withMemberLocations(
  rawModel: unknown,
  specs: readonly MemberLocationSpec[],
): Record<string, unknown> | null {
  if (specs.length === 0) return null;
  const model = requireModel(rawModel);
  const points = recordArray(model.points);
  const locations = [...recordArray(model.locations)];

  for (const spec of specs) {
    const meta = locationMetaFor(locations, spec.type);
    upsertInto(locations, buildLocation(spec, points, meta));
  }

  return { ...model, locations };
}

export function withoutLocations(
  rawModel: unknown,
  locationNames: Iterable<string>,
): Record<string, unknown> | null {
  const names = new Set(locationNames);
  if (names.size === 0) return null;
  const model = requireModel(rawModel);
  const locations = recordArray(model.locations).filter((location) => {
    const name = typeof location.name === 'string' ? location.name : undefined;
    return !name || !names.has(name);
  });
  return { ...model, locations };
}
