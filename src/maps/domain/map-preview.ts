import type { ZoneEntity } from '../../zones/entities/zone.entity';
import { ZoneStatus, ZoneType } from '../../zones/entities/zone.entity';
import { pointNameOf } from '../../zones/domain/location-naming';
import type {
  MapRecordEntity,
  StoredMapPreview,
} from '../infrastructure/entities/map-record.entity';
import type { parseOpenTcsXml } from '../../opentcs/map-loader/opentcs-xml.parser';

export interface MapPreviewAreaDto {
  id: string;
  name: string;
  kind: 'ZONE' | 'STORE';
  status: 'ACTIVE' | 'STALE';
  color: string;
  pointNames: string[];
}

export interface MapLibraryItemDto {
  id: string;
  name: string;
  originalFilename: string;
  pointCount: number;
  pathCount: number;
  vehicleCount: number;
  locationCount: number;
  blockCount: number;
  uploadedAt: Date;
  uploadedById: string | null;
  lastLoadedAt: Date | null;
  active: boolean;
  preview: StoredMapPreview;
  areas: MapPreviewAreaDto[];
}

export interface MapLibraryDetailDto extends MapLibraryItemDto {
  points: Array<{
    name: string;
    type: string;
    x: number;
    y: number;
    z: number;
  }>;
  paths: Array<{
    name: string;
    source: string;
    target: string;
    length: number;
    locked: boolean;
  }>;
  locations: Array<{ name: string; type: string; pointNames: string[] }>;
  vehicles: string[];
  blocks: Array<{ name: string; type: string; memberNames: string[] }>;
}

/** Bump when a change to `previewOf` would render existing stored previews stale. */
export const CURRENT_PREVIEW_VERSION = 1;

/** Render-ready geometry for a map library card's thumbnail — derived from the parsed XML, never a substitute for it. */
export function previewOf(
  model: ReturnType<typeof parseOpenTcsXml>,
): StoredMapPreview {
  return {
    previewVersion: CURRENT_PREVIEW_VERSION,
    points: model.points.map((point) => ({
      name: point.name,
      x: point.position.x,
      y: point.position.y,
      type: point.type,
    })),
    paths: model.paths.map((path) => ({
      name: path.name,
      source: path.srcPointName,
      target: path.destPointName,
      locked: path.locked,
    })),
  };
}

export function toLibraryItem(
  record: MapRecordEntity,
  active: boolean,
  areas: MapPreviewAreaDto[] = [],
): MapLibraryItemDto {
  return {
    id: record.id,
    name: record.name,
    originalFilename: record.originalFilename,
    pointCount: record.pointCount,
    pathCount: record.pathCount,
    vehicleCount: record.vehicleCount,
    locationCount: record.locationCount,
    blockCount: record.blockCount,
    uploadedAt: record.uploadedAt,
    uploadedById: record.uploadedById,
    lastLoadedAt: record.lastLoadedAt,
    active,
    preview: record.preview ?? {
      previewVersion: CURRENT_PREVIEW_VERSION,
      points: [],
      paths: [],
    },
    areas,
  };
}

/**
 * Areas belonging to exactly this map record — matched by `mapRecordId`, never by name or by
 * "every member point happens to exist here" (two records can share a name or a topology; see
 * PLAN §2, §6.1 and `resolveBackfillMatch`). A zone whose `mapRecordId` hasn't been resolved yet
 * (legacy data, or an ambiguous name at backfill time) simply isn't shown on any map until an
 * operator resolves it via `assignToLoadedMap` — safer than guessing.
 */
export function areasForMap(
  mapRecordId: string,
  zones: readonly ZoneEntity[],
): MapPreviewAreaDto[] {
  return zones
    .filter((zone) => zone.mapRecordId === mapRecordId)
    .map((zone) => toPreviewArea(zone));
}

export function toPreviewArea(zone: ZoneEntity): MapPreviewAreaDto {
  return {
    id: zone.id,
    name: zone.name,
    kind: zone.type === ZoneType.PICKUP ? 'ZONE' : 'STORE',
    status: zone.status === ZoneStatus.ACTIVE ? 'ACTIVE' : 'STALE',
    color:
      zone.color ?? (zone.type === ZoneType.PICKUP ? '#2563EB' : '#16A34A'),
    pointNames: [...zone.members]
      .sort((a, b) => a.positionIndex - b.positionIndex)
      .map((member) => pointNameOf(member.locationName)),
  };
}
