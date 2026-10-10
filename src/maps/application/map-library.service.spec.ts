import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PlantModelWriter } from '../../opentcs/plant-model-writer.service';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MapLibraryService } from './map-library.service';
import { MapRecordEntity } from '../infrastructure/entities/map-record.entity';
import {
  ZoneEntity,
  ZoneStatus,
  ZoneType,
} from '../../zones/entities/zone.entity';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { ZoneService } from '../../zones/zone.service';
import { ActiveMapRecordService } from '../infrastructure/active-map-record.service';

type RepoMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  softDelete: jest.Mock;
};

function makeRepo(): RepoMock {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn((entity: unknown) => entity),
    update: jest.fn().mockResolvedValue(undefined),
    softDelete: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MapLibraryService', () => {
  let service: MapLibraryService;
  let mapRepo: RepoMock;
  let zoneRepo: RepoMock;
  let kernelApi: {
    getRawPlantModel: jest.Mock;
    getPlantModelName: jest.Mock;
    putRawPlantModel: jest.Mock;
    setKernelState: jest.Mock;
    getKernelState: jest.Mock;
    initializeVehiclesForOperation: jest.Mock;
  };
  let zoneService: { sync: jest.Mock };
  let activeMapRecords: { resolveId: jest.Mock };

  beforeEach(async () => {
    mapRepo = makeRepo();
    zoneRepo = makeRepo();
    mapRepo.find.mockResolvedValue([]);
    zoneRepo.find.mockResolvedValue([]);
    kernelApi = {
      getRawPlantModel: jest.fn(),
      getPlantModelName: jest.fn().mockResolvedValue(null),
      putRawPlantModel: jest.fn(),
      setKernelState: jest.fn().mockResolvedValue(undefined),
      getKernelState: jest.fn(),
      initializeVehiclesForOperation: jest.fn().mockResolvedValue(undefined),
    };
    zoneService = {
      sync: jest.fn().mockResolvedValue({
        plantModelName: null,
        total: 0,
        markedStale: 0,
        markedActive: 0,
        skippedOtherMaps: 0,
        unassigned: 0,
        kernelUnreachable: false,
      }),
    };
    activeMapRecords = { resolveId: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MapLibraryService,
        PlantModelWriter,
        { provide: KernelApiService, useValue: kernelApi },
        { provide: getRepositoryToken(MapRecordEntity), useValue: mapRepo },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: ZoneService, useValue: zoneService },
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(MapLibraryService);
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <model name="factory-a">
      <point name="P1" positionX="100" positionY="200" positionZ="0" type="HALT_POSITION" />
      <point name="P2" positionX="300" positionY="200" positionZ="0" type="HALT_POSITION" />
      <path name="P1---P2" sourcePoint="P1" destinationPoint="P2" length="200" maxVelocity="1000" maxReverseVelocity="0" locked="false" />
      <visualLayout name="layout" scaleX="1" scaleY="1" />
    </model>`;

  it('stores XML and preview data without pushing the upload into the kernel', async () => {
    mapRepo.save.mockImplementation((entity: MapRecordEntity) =>
      Promise.resolve({
        ...entity,
        id: entity.id ?? 'map-1',
        uploadedAt: entity.uploadedAt ?? new Date('2026-09-14T00:00:00Z'),
      }),
    );

    const result = await service.uploadToLibrary(
      Buffer.from(xml),
      'factory-a.xml',
      'user-1',
    );

    expect(result).toMatchObject({
      id: 'map-1',
      name: 'factory-a',
      originalFilename: 'factory-a.xml',
      pointCount: 2,
      pathCount: 1,
      preview: {
        points: [
          expect.objectContaining({ name: 'P1', x: 100, y: 200 }),
          expect.objectContaining({ name: 'P2', x: 300, y: 200 }),
        ],
        paths: [
          expect.objectContaining({
            name: 'P1---P2',
            source: 'P1',
            target: 'P2',
          }),
        ],
      },
    });
    expect(mapRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ xmlContent: xml }),
    );
    expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
    expect(kernelApi.setKernelState).not.toHaveBeenCalled();
  });

  it('merges WES zones into the preview of their plant model', async () => {
    mapRepo.find.mockResolvedValue([
      {
        id: 'map-1',
        name: 'factory-a',
        originalFilename: 'factory-a.xml',
        pointCount: 2,
        pathCount: 1,
        vehicleCount: 0,
        locationCount: 0,
        blockCount: 0,
        preview: { points: [], paths: [] },
        uploadedAt: new Date('2026-09-14T00:00:00Z'),
        uploadedById: 'user-1',
        lastLoadedAt: null,
      },
    ]);
    zoneRepo.find.mockResolvedValue([
      {
        id: 'zone-1',
        name: 'Kho nhận',
        type: ZoneType.PICKUP,
        color: '#2563EB',
        plantModelName: 'factory-a',
        mapRecordId: 'map-1',
        status: ZoneStatus.ACTIVE,
        members: [
          { locationName: 'location_P2', positionIndex: 1 },
          { locationName: 'location_P1', positionIndex: 0 },
        ],
      },
    ]);
    activeMapRecords.resolveId.mockResolvedValue('map-1');

    await expect(service.listLibrary()).resolves.toEqual([
      expect.objectContaining({
        id: 'map-1',
        active: true,
        areas: [
          {
            id: 'zone-1',
            name: 'Kho nhận',
            kind: 'ZONE',
            status: 'ACTIVE',
            color: '#2563EB',
            pointNames: ['P1', 'P2'],
          },
        ],
      }),
    ]);
  });

  it('never shows a zone under a record it is not scoped to, even with identical topology or a shared name', async () => {
    // Two uploaded records can share a name and/or point layout — see PLAN §2, §6.1. A zone's
    // `mapRecordId` is the only thing allowed to decide which record's preview it appears
    // under; matching by name or by "every member point happens to exist here" is exactly the
    // bug this fixes, so neither should resurrect a zone that belongs to a different record.
    mapRepo.find.mockResolvedValue([
      {
        id: 'map-renamed',
        name: 'factory-renamed',
        originalFilename: 'factory-renamed.xml',
        pointCount: 2,
        pathCount: 1,
        vehicleCount: 0,
        locationCount: 0,
        blockCount: 0,
        preview: {
          points: [
            { name: 'P1', x: 0, y: 0, type: 'HALT_POSITION' },
            { name: 'P2', x: 1000, y: 0, type: 'HALT_POSITION' },
          ],
          paths: [],
        },
        uploadedAt: new Date('2026-09-14T00:00:00Z'),
        uploadedById: 'user-1',
        lastLoadedAt: null,
      },
    ]);
    zoneRepo.find.mockResolvedValue([
      {
        id: 'same-name-different-record',
        name: 'Kho cũ tương thích',
        type: ZoneType.DROPOFF,
        color: '#16A34A',
        plantModelName: 'factory-renamed',
        mapRecordId: 'some-other-record-id',
        status: ZoneStatus.ACTIVE,
        members: [
          { locationName: 'location_P1', positionIndex: 0 },
          { locationName: 'location_P2', positionIndex: 1 },
        ],
      },
      {
        id: 'unresolved',
        name: 'Chưa gán bản đồ',
        type: ZoneType.DROPOFF,
        color: '#16A34A',
        plantModelName: null,
        mapRecordId: null,
        status: ZoneStatus.ACTIVE,
        members: [
          { locationName: 'location_P1', positionIndex: 0 },
          { locationName: 'location_P2', positionIndex: 1 },
        ],
      },
    ]);
    activeMapRecords.resolveId.mockResolvedValue(null);

    const result = await service.listLibrary();

    expect(result[0].areas).toEqual([]);
  });

  it('pushes the XML straight to the kernel, re-integrates vehicles, and syncs zones', async () => {
    const record = {
      id: 'map-1',
      name: 'factory-a',
      originalFilename: 'factory-a.xml',
      pointCount: 2,
      pathCount: 1,
      vehicleCount: 0,
      locationCount: 0,
      blockCount: 0,
      xmlContent: xml,
      preview: { points: [], paths: [] },
      uploadedAt: new Date('2026-09-14T00:00:00Z'),
      uploadedById: 'user-1',
      lastLoadedAt: null,
    };
    mapRepo.findOne.mockResolvedValue(record);
    mapRepo.save.mockImplementation((entity: MapRecordEntity) =>
      Promise.resolve(entity),
    );

    await expect(service.loadLibraryMap('map-1')).resolves.toMatchObject({
      id: 'map-1',
      name: 'factory-a',
      active: true,
    });

    expect(mapRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'map-1' } }),
    );
    expect(kernelApi.setKernelState).not.toHaveBeenCalled();
    expect(kernelApi.getKernelState).not.toHaveBeenCalled();
    expect(kernelApi.putRawPlantModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'factory-a' }),
    );
    expect(kernelApi.initializeVehiclesForOperation).toHaveBeenCalledTimes(1);
    expect(zoneService.sync).toHaveBeenCalledTimes(1);
    expect(record.lastLoadedAt).toBeInstanceOf(Date);
  });

  it('still marks the map as loaded when zone sync itself fails', async () => {
    const record = {
      id: 'map-1',
      name: 'factory-a',
      originalFilename: 'factory-a.xml',
      pointCount: 2,
      pathCount: 1,
      vehicleCount: 0,
      locationCount: 0,
      blockCount: 0,
      xmlContent: xml,
      preview: { points: [], paths: [] },
      uploadedAt: new Date('2026-09-14T00:00:00Z'),
      uploadedById: 'user-1',
      lastLoadedAt: null,
    };
    mapRepo.findOne.mockResolvedValue(record);
    mapRepo.save.mockImplementation((entity: MapRecordEntity) =>
      Promise.resolve(entity),
    );
    zoneService.sync.mockRejectedValue(new Error('kernel busy'));

    await expect(service.loadLibraryMap('map-1')).resolves.toMatchObject({
      id: 'map-1',
      active: true,
    });
    expect(record.lastLoadedAt).toBeInstanceOf(Date);
  });

  describe('deleteLibraryMap', () => {
    const stored = { id: 'map-1', name: 'factory-a', xmlContent: xml };

    it('soft-deletes a stored map the kernel is not running', async () => {
      mapRepo.findOne.mockResolvedValue(stored);
      activeMapRecords.resolveId.mockResolvedValue('map-2');

      await service.deleteLibraryMap('map-1', 'user-1');

      expect(mapRepo.softDelete).toHaveBeenCalledWith({ id: 'map-1' });
      expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
    });

    it('refuses to delete the map the kernel is running', async () => {
      mapRepo.findOne.mockResolvedValue(stored);
      activeMapRecords.resolveId.mockResolvedValue('map-1');

      await expect(
        service.deleteLibraryMap('map-1', 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mapRepo.softDelete).not.toHaveBeenCalled();
    });

    it('refuses while the running kernel model cannot be read', async () => {
      mapRepo.findOne.mockResolvedValue(stored);
      activeMapRecords.resolveId.mockResolvedValue(null);
      kernelApi.getRawPlantModel.mockResolvedValue(null);

      await expect(
        service.deleteLibraryMap('map-1', 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mapRepo.softDelete).not.toHaveBeenCalled();
    });

    it('deletes when the kernel runs a model no stored map matches', async () => {
      mapRepo.findOne.mockResolvedValue(stored);
      activeMapRecords.resolveId.mockResolvedValue(null);
      kernelApi.getRawPlantModel.mockResolvedValue({ name: 'other' });

      await service.deleteLibraryMap('map-1', 'user-1');

      expect(mapRepo.softDelete).toHaveBeenCalledWith({ id: 'map-1' });
    });

    it('answers NotFound for an unknown or already deleted map', async () => {
      mapRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deleteLibraryMap('map-9', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers Forbidden for a map outside the caller scope', async () => {
      mapRepo.findOne.mockResolvedValue(stored);

      await expect(
        service.deleteLibraryMap('map-1', 'user-1', ['map-2']),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mapRepo.softDelete).not.toHaveBeenCalled();
    });
  });
});

describe('MapLibraryService preview versioning', () => {
  let service: MapLibraryService;
  let mapRepo: RepoMock;
  let zoneRepo: RepoMock;
  let kernelApi: { getPlantModelName: jest.Mock };
  let activeMapRecords: { resolveId: jest.Mock };

  beforeEach(async () => {
    mapRepo = makeRepo();
    zoneRepo = makeRepo();
    zoneRepo.find.mockResolvedValue([]);
    kernelApi = { getPlantModelName: jest.fn().mockResolvedValue(null) };
    activeMapRecords = { resolveId: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MapLibraryService,
        PlantModelWriter,
        { provide: KernelApiService, useValue: kernelApi },
        { provide: getRepositoryToken(MapRecordEntity), useValue: mapRepo },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: ZoneService, useValue: { sync: jest.fn() } },
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(MapLibraryService);
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <model name="factory-a">
      <point name="P1" positionX="100" positionY="200" positionZ="0" type="HALT_POSITION" />
      <point name="P2" positionX="300" positionY="200" positionZ="0" type="HALT_POSITION" />
      <path name="P1---P2" sourcePoint="P1" destinationPoint="P2" length="200" maxVelocity="1000" maxReverseVelocity="0" locked="false" />
      <visualLayout name="layout" scaleX="1" scaleY="1" />
    </model>`;

  const legacyRecord = () => ({
    id: 'map-1',
    name: 'factory-a',
    originalFilename: 'factory-a.xml',
    pointCount: 2,
    pathCount: 1,
    vehicleCount: 0,
    locationCount: 0,
    blockCount: 0,
    xmlContent: xml,
    preview: { points: [], paths: [] },
    uploadedAt: new Date('2026-09-14T00:00:00Z'),
    uploadedById: 'user-1',
    lastLoadedAt: null,
  });

  it('listLibrary regenerates and persists a legacy preview (no previewVersion) from its stored XML', async () => {
    const record = legacyRecord();
    mapRepo.find
      .mockResolvedValueOnce([record]) // the primary listing query
      .mockResolvedValueOnce([{ id: 'map-1', xmlContent: xml }]); // refreshStalePreviews' targeted xmlContent lookup

    const [item] = await service.listLibrary();

    expect(item.preview).toMatchObject({
      previewVersion: 1,
      points: [
        expect.objectContaining({ name: 'P1' }),
        expect.objectContaining({ name: 'P2' }),
      ],
    });
    expect(mapRepo.update).toHaveBeenCalledWith(
      { id: 'map-1' },
      { preview: item.preview },
    );
  });

  it('listLibrary leaves an already-current preview untouched', async () => {
    const current = { previewVersion: 1, points: [], paths: [] };
    const record = { ...legacyRecord(), preview: current };
    mapRepo.find.mockResolvedValueOnce([record]);

    const [item] = await service.listLibrary();

    expect(item.preview).toBe(current);
    expect(mapRepo.update).not.toHaveBeenCalled();
    expect(mapRepo.find).toHaveBeenCalledTimes(1); // no second, stale-lookup call
  });

  it('getLibraryMap regenerates and persists a stale preview inline, from the model it already parsed', async () => {
    const record = legacyRecord();
    mapRepo.findOne.mockResolvedValue(record);

    const detail = await service.getLibraryMap('map-1');

    expect(detail.preview).toMatchObject({ previewVersion: 1 });
    expect(mapRepo.update).toHaveBeenCalledWith(
      { id: 'map-1' },
      { preview: detail.preview },
    );
  });
});

describe('MapLibraryService AUTH-3 map scope', () => {
  let service: MapLibraryService;
  let mapRepo: RepoMock;
  let zoneRepo: RepoMock;
  let kernelApi: { getPlantModelName: jest.Mock };
  let activeMapRecords: { resolveId: jest.Mock };

  beforeEach(async () => {
    mapRepo = makeRepo();
    zoneRepo = makeRepo();
    zoneRepo.find.mockResolvedValue([]);
    kernelApi = { getPlantModelName: jest.fn().mockResolvedValue(null) };
    activeMapRecords = { resolveId: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MapLibraryService,
        PlantModelWriter,
        { provide: KernelApiService, useValue: kernelApi },
        { provide: getRepositoryToken(MapRecordEntity), useValue: mapRepo },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: ZoneService, useValue: { sync: jest.fn() } },
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(MapLibraryService);
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <model name="factory-a">
      <point name="P1" positionX="100" positionY="200" positionZ="0" type="HALT_POSITION" />
      <visualLayout name="layout" scaleX="1" scaleY="1" />
    </model>`;

  const record = (
    overrides: Partial<MapRecordEntity> = {},
  ): MapRecordEntity => ({
    id: 'map-a',
    name: 'factory-a',
    originalFilename: 'factory-a.xml',
    pointCount: 1,
    pathCount: 0,
    vehicleCount: 0,
    locationCount: 0,
    blockCount: 0,
    xmlContent: xml,
    preview: { previewVersion: 1, points: [], paths: [] },
    uploadedAt: new Date('2026-09-14T00:00:00Z'),
    uploadedById: 'user-1',
    lastLoadedAt: null,
    deletedAt: null,
    ...overrides,
  });

  describe('listLibrary', () => {
    it('is unaffected when mapIds is undefined (unrestricted — regression guard)', async () => {
      mapRepo.find.mockResolvedValueOnce([record()]);
      await service.listLibrary(undefined);
      expect(mapRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({ id: expect.anything() }),
        }),
      );
    });

    it('filters via a real TypeORM In() where-clause when mapIds is scoped', async () => {
      mapRepo.find.mockResolvedValueOnce([record({ id: 'map-a' })]);
      await service.listLibrary(['map-a', 'map-b']);
      expect(mapRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: expect.objectContaining({
              _type: 'in',
              _value: ['map-a', 'map-b'],
            }),
          }),
        }),
      );
    });
  });

  describe('getLibraryMap / getLibraryXml / loadLibraryMap — instance scope check', () => {
    it('getLibraryMap throws Forbidden for an out-of-scope id', async () => {
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-a' }));
      await expect(service.getLibraryMap('map-a', ['map-b'])).rejects.toThrow(
        'Vai trò của bạn không được gán quyền thao tác trên bản đồ này.',
      );
    });

    it('getLibraryMap succeeds for an in-scope id', async () => {
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-a' }));
      await expect(
        service.getLibraryMap('map-a', ['map-a', 'map-b']),
      ).resolves.toMatchObject({ id: 'map-a' });
    });

    it('getLibraryXml throws Forbidden for an out-of-scope id', async () => {
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-a' }));
      await expect(service.getLibraryXml('map-a', ['map-b'])).rejects.toThrow(
        'Vai trò của bạn không được gán quyền thao tác trên bản đồ này.',
      );
    });

    it('loadLibraryMap throws Forbidden for an out-of-scope id, before touching the kernel', async () => {
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-a' }));
      await expect(service.loadLibraryMap('map-a', ['map-b'])).rejects.toThrow(
        'Vai trò của bạn không được gán quyền thao tác trên bản đồ này.',
      );
    });

    it('every method is unaffected when mapIds is undefined (unrestricted)', async () => {
      mapRepo.findOne.mockResolvedValue(record({ id: 'map-a' }));
      await expect(
        service.getLibraryMap('map-a', undefined),
      ).resolves.toMatchObject({ id: 'map-a' });
    });
  });
});

/**
 * Gate 4 item 6: "Contract test load → sync đúng map" — loading one stored map must never read,
 * write, or otherwise affect a second stored map, and the response it returns must only carry
 * that map's own areas. `ZoneService.sync()`'s own scoping to the active map's zones is already
 * covered by its own spec; this only proves MapLibraryService's orchestration doesn't leak.
 */
describe('MapLibraryService load→sync contract (Gate 4 item 6)', () => {
  let service: MapLibraryService;
  let mapRepo: RepoMock;
  let zoneRepo: RepoMock;
  let zoneService: { sync: jest.Mock };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <model name="factory-a">
      <point name="P1" positionX="100" positionY="200" positionZ="0" type="HALT_POSITION" />
      <visualLayout name="layout" scaleX="1" scaleY="1" />
    </model>`;

  const recordA = () => ({
    id: 'map-a',
    name: 'factory-a',
    originalFilename: 'factory-a.xml',
    pointCount: 1,
    pathCount: 0,
    vehicleCount: 0,
    locationCount: 0,
    blockCount: 0,
    xmlContent: xml,
    preview: { previewVersion: 1, points: [], paths: [] },
    uploadedAt: new Date('2026-09-14T00:00:00Z'),
    uploadedById: 'user-1',
    lastLoadedAt: null as Date | null,
  });
  const recordB = () => ({
    ...recordA(),
    id: 'map-b',
    name: 'factory-b',
    originalFilename: 'factory-b.xml',
  });

  beforeEach(async () => {
    mapRepo = makeRepo();
    zoneRepo = makeRepo();
    zoneRepo.find.mockResolvedValue([]);
    zoneService = {
      sync: jest.fn().mockResolvedValue({ markedActive: 0, markedStale: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MapLibraryService,
        PlantModelWriter,
        {
          provide: KernelApiService,
          useValue: {
            putRawPlantModel: jest.fn(),
            initializeVehiclesForOperation: jest
              .fn()
              .mockResolvedValue(undefined),
          },
        },
        { provide: getRepositoryToken(MapRecordEntity), useValue: mapRepo },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: ZoneService, useValue: zoneService },
        {
          provide: ActiveMapRecordService,
          useValue: { resolveId: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(MapLibraryService);
  });

  it('loading one map only queries and saves that map — a second stored map is never touched', async () => {
    const a = recordA();
    const b = recordB();
    mapRepo.findOne.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === a.id ? a : null),
    );
    mapRepo.save.mockImplementation((entity: typeof a) =>
      Promise.resolve(entity),
    );

    await service.loadLibraryMap('map-a');

    expect(mapRepo.findOne).toHaveBeenCalledTimes(1);
    expect(mapRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'map-a' } }),
    );
    expect(mapRepo.save).toHaveBeenCalledTimes(1);
    expect(mapRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'map-a' }),
    );
    expect(a.lastLoadedAt).toBeInstanceOf(Date);
    expect(b.lastLoadedAt).toBeNull();
  });

  it("the loaded map's response only carries areas scoped to its own mapRecordId, never a sibling map's zones", async () => {
    const a = recordA();
    mapRepo.findOne.mockResolvedValue(a);
    mapRepo.save.mockImplementation((entity: typeof a) =>
      Promise.resolve(entity),
    );
    zoneRepo.find.mockResolvedValue([
      {
        id: 'zone-a',
        name: 'Zone A',
        type: ZoneType.PICKUP,
        color: null,
        plantModelName: 'factory-a',
        mapRecordId: 'map-a',
        status: ZoneStatus.ACTIVE,
        members: [],
      },
      {
        id: 'zone-b',
        name: 'Zone B',
        type: ZoneType.PICKUP,
        color: null,
        plantModelName: 'factory-b',
        mapRecordId: 'map-b',
        status: ZoneStatus.ACTIVE,
        members: [],
      },
    ]);

    const result = await service.loadLibraryMap('map-a');

    expect(result.areas.map((area) => area.id)).toEqual(['zone-a']);
  });

  it('sync runs exactly once per load, unconditionally — never once per stored map', async () => {
    const a = recordA();
    mapRepo.findOne.mockResolvedValue(a);
    mapRepo.save.mockImplementation((entity: typeof a) =>
      Promise.resolve(entity),
    );

    await service.loadLibraryMap('map-a');

    expect(zoneService.sync).toHaveBeenCalledTimes(1);
    expect(zoneService.sync).toHaveBeenCalledWith();
  });
});
