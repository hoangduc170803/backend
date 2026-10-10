import {
  ZoneStatus,
  ZoneType,
  type ZoneEntity,
} from '../../zones/entities/zone.entity';
import {
  areasForMap,
  CURRENT_PREVIEW_VERSION,
  previewOf,
  toLibraryItem,
  toPreviewArea,
} from './map-preview';
import type { MapRecordEntity } from '../infrastructure/entities/map-record.entity';
import type { parseOpenTcsXml } from '../../opentcs/map-loader/opentcs-xml.parser';

const zone = (overrides: Partial<ZoneEntity> = {}): ZoneEntity => ({
  id: 'zone-1',
  name: 'Kho A',
  type: ZoneType.PICKUP,
  color: null,
  operation: null,
  maxVehicles: null,
  kernelId: null,
  plantModelName: 'factory-a',
  mapRecordId: 'record-1',
  status: ZoneStatus.ACTIVE,
  members: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  ...overrides,
});

describe('areasForMap', () => {
  it('includes only zones whose mapRecordId matches exactly', () => {
    const a = zone({ id: 'a', mapRecordId: 'record-1' });
    const b = zone({ id: 'b', mapRecordId: 'record-2' });
    const unresolved = zone({ id: 'c', mapRecordId: null });

    const result = areasForMap('record-1', [a, b, unresolved]);

    expect(result.map((area) => area.id)).toEqual(['a']);
  });

  it('returns nothing for a record no zone belongs to', () => {
    expect(
      areasForMap('record-x', [zone({ mapRecordId: 'record-1' })]),
    ).toEqual([]);
  });
});

describe('toPreviewArea', () => {
  it('maps PICKUP to ZONE and DROPOFF to STORE', () => {
    expect(toPreviewArea(zone({ type: ZoneType.PICKUP })).kind).toBe('ZONE');
    expect(toPreviewArea(zone({ type: ZoneType.DROPOFF })).kind).toBe('STORE');
  });

  it('falls back to a type-based default color when the zone has none', () => {
    expect(
      toPreviewArea(zone({ type: ZoneType.PICKUP, color: null })).color,
    ).toBe('#2563EB');
    expect(
      toPreviewArea(zone({ type: ZoneType.DROPOFF, color: null })).color,
    ).toBe('#16A34A');
  });

  it("uses the zone's own color when set", () => {
    expect(toPreviewArea(zone({ color: '#ABCDEF' })).color).toBe('#ABCDEF');
  });

  it('orders member point names by positionIndex, not insertion order', () => {
    const withMembers = zone({
      members: [
        {
          id: 'm2',
          zoneId: 'zone-1',
          zone: {} as ZoneEntity,
          locationName: 'location_P2',
          positionIndex: 1,
          createdAt: new Date(),
        },
        {
          id: 'm1',
          zoneId: 'zone-1',
          zone: {} as ZoneEntity,
          locationName: 'location_P1',
          positionIndex: 0,
          createdAt: new Date(),
        },
      ],
    });
    expect(toPreviewArea(withMembers).pointNames).toEqual(['P1', 'P2']);
  });
});

describe('toLibraryItem', () => {
  const record = (
    overrides: Partial<MapRecordEntity> = {},
  ): MapRecordEntity => ({
    id: 'map-1',
    name: 'factory-a',
    originalFilename: 'factory-a.xml',
    pointCount: 2,
    pathCount: 1,
    vehicleCount: 0,
    locationCount: 0,
    blockCount: 0,
    xmlContent: null,
    preview: null,
    uploadedAt: new Date('2026-01-01'),
    uploadedById: 'user-1',
    lastLoadedAt: null,
    deletedAt: null,
    ...overrides,
  });

  it('defaults preview to empty points/paths at the current version when the record has none stored', () => {
    expect(toLibraryItem(record(), false).preview).toEqual({
      previewVersion: CURRENT_PREVIEW_VERSION,
      points: [],
      paths: [],
    });
  });

  it('carries the active flag and areas through unchanged', () => {
    const areas = [toPreviewArea(zone())];
    expect(toLibraryItem(record(), true, areas)).toMatchObject({
      active: true,
      areas,
    });
  });
});

describe('previewOf', () => {
  const model = {
    name: 'factory-a',
    points: [
      { name: 'P1', position: { x: 100, y: 200, z: 0 }, type: 'HALT_POSITION' },
      { name: 'P2', position: { x: 300, y: 200, z: 0 }, type: 'HALT_POSITION' },
    ],
    paths: [
      {
        name: 'P1---P2',
        srcPointName: 'P1',
        destPointName: 'P2',
        length: 200,
        locked: false,
      },
    ],
  } as unknown as ReturnType<typeof parseOpenTcsXml>;

  it('stamps the current preview version and derives render-ready geometry from the parsed model', () => {
    expect(previewOf(model)).toEqual({
      previewVersion: CURRENT_PREVIEW_VERSION,
      points: [
        { name: 'P1', x: 100, y: 200, type: 'HALT_POSITION' },
        { name: 'P2', x: 300, y: 200, type: 'HALT_POSITION' },
      ],
      paths: [{ name: 'P1---P2', source: 'P1', target: 'P2', locked: false }],
    });
  });
});
