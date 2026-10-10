import { QueryFailedError } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlantModelWriter } from '../opentcs/plant-model-writer.service';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { ZoneService } from './zone.service';
import { ZoneEntity, ZoneStatus, ZoneType } from './entities/zone.entity';
import { ZoneMemberEntity } from './entities/zone-member.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { CargoEntity } from '../cargo/entities/cargo.entity';
import { ZoneLocationWriter } from './zone-location.writer';
import { ZoneUsageQuery } from './zone-usage.query';
import { ActiveMapRecordService } from '../maps/infrastructure/active-map-record.service';

/** The `map_records.id` `ActiveMapRecordService` resolves to in these tests by default. */
const ACTIVE_RECORD_ID = 'active-record-1';

const makeZone = (overrides: Partial<ZoneEntity> = {}): ZoneEntity => ({
  id: 'zone-1',
  name: 'Dropoff A',
  type: ZoneType.DROPOFF,
  color: '#2563eb',
  operation: null,
  maxVehicles: null,
  kernelId: 1,
  plantModelName: 'runtime-map',
  mapRecordId: ACTIVE_RECORD_ID,
  status: ZoneStatus.ACTIVE,
  members: [],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
  ...overrides,
});

const makeMember = (
  locationName: string,
  positionIndex: number,
): ZoneMemberEntity => ({
  id: `member-${positionIndex}`,
  zoneId: 'zone-1',
  zone: {} as ZoneEntity,
  locationName,
  positionIndex,
  createdAt: new Date('2026-01-01'),
});

const makePlantModel = ({
  pointNames,
  locations,
}: {
  pointNames: string[];
  locations: Array<{ name: string; links: string[] }>;
}) => ({
  name: 'runtime-map',
  points: pointNames.map((name) => ({
    name,
    position: { x: 0, y: 0, z: 0 },
  })),
  locations: locations.map((location) => ({
    name: location.name,
    links: location.links.map((pointName) => ({ pointName })),
  })),
});

type RepoMock = {
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

function makeRepo(): RepoMock {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((entity: unknown) => Promise.resolve(entity)),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

describe('ZoneService.sync', () => {
  let service: ZoneService;
  let zoneRepo: RepoMock;
  let memberRepo: RepoMock;
  let kernelApi: {
    getRawPlantModel: jest.Mock;
    getPlantModelName: jest.Mock;
    invalidatePlantModelCache: jest.Mock;
    putRawPlantModel: jest.Mock;
    getVehicleStates: jest.Mock;
    setVehicleAdapterEnabled: jest.Mock;
    setVehicleIntegrationLevel: jest.Mock;
  };
  let activeMapRecords: { resolveId: jest.Mock };

  beforeEach(async () => {
    zoneRepo = makeRepo();
    memberRepo = makeRepo();
    kernelApi = {
      getRawPlantModel: jest.fn(),
      getPlantModelName: jest.fn().mockResolvedValue('runtime-map'),
      invalidatePlantModelCache: jest.fn(),
      // Default: kernel accepts the write (MODELLING). OPERATING cases override
      // this with a rejection.
      putRawPlantModel: jest.fn().mockResolvedValue(undefined),
      // A plant-model write re-inits vehicles; the writer snapshots + restores them.
      getVehicleStates: jest.fn().mockResolvedValue([]),
      setVehicleAdapterEnabled: jest.fn().mockResolvedValue(undefined),
      setVehicleIntegrationLevel: jest.fn().mockResolvedValue(undefined),
    };
    activeMapRecords = {
      resolveId: jest.fn().mockResolvedValue(ACTIVE_RECORD_ID),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneService,
        {
          provide: getDataSourceToken(),
          useValue: { query: jest.fn() },
        },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: getRepositoryToken(ZoneMemberEntity), useValue: memberRepo },
        { provide: KernelApiService, useValue: kernelApi },
        ZoneLocationWriter,
        PlantModelWriter,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
        ZoneUsageQuery,
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
        {
          provide: ActiveMapContext,
          useValue: { id: activeMapRecords.resolveId },
        },
        {
          provide: getRepositoryToken(CargoEntity),
          useValue: {
            createQueryBuilder: jest.fn(() => ({
              select: jest.fn().mockReturnThis(),
              addSelect: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              groupBy: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            })),
          },
        },
      ],
    }).compile();

    service = module.get(ZoneService);
  });

  const makePickupZone = (
    id: string,
    name: string,
    status: ZoneStatus,
    locationNames: string[],
  ): ZoneEntity =>
    makeZone({
      id,
      name,
      type: ZoneType.PICKUP,
      kernelId: null,
      status,
      members: locationNames.map((locationName, index) =>
        makeMember(locationName, index),
      ),
    });

  it('leaves an already-valid ACTIVE zone ACTIVE and writes nothing', async () => {
    const zone = makeZone({
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P1', 0), makeMember('location_P2', 1)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({
        pointNames: ['P1', 'P2'],
        locations: [
          { name: 'location_P1', links: ['P1'] },
          { name: 'location_P2', links: ['P2'] },
        ],
      }),
    );

    const result = await service.sync();

    expect(result).toEqual({
      plantModelName: 'runtime-map',
      total: 1,
      markedStale: 0,
      markedActive: 0,
      skippedOtherMaps: 0,
      unassigned: 0,
      kernelUnreachable: false,
    });
    expect(zoneRepo.save).not.toHaveBeenCalled();
    expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
  });

  it('rebuilds a repairable ACTIVE zone in the kernel while keeping it ACTIVE', async () => {
    const zone = makeZone({
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P1', 0), makeMember('location_P2', 1)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    // Points still exist but every location is gone (map reloaded without them).
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1', 'P2'], locations: [] }),
    );

    const result = await service.sync();

    expect(result.markedStale).toBe(0);
    expect(kernelApi.putRawPlantModel).toHaveBeenCalledTimes(1);
    const pushed = kernelApi.putRawPlantModel.mock.calls[0][0] as {
      locations: Array<{ name: string }>;
    };
    expect(pushed.locations.map((location) => location.name).sort()).toEqual([
      'location_P1',
      'location_P2',
    ]);
  });

  it('does not resurrect a STALE zone even if its points still exist', async () => {
    const zone = makeZone({
      status: ZoneStatus.STALE,
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    const result = await service.sync();

    expect(result).toEqual({
      plantModelName: 'runtime-map',
      total: 1,
      markedStale: 0,
      markedActive: 0,
      skippedOtherMaps: 0,
      unassigned: 0,
      kernelUnreachable: false,
    });
    expect(zoneRepo.save).not.toHaveBeenCalled();
    expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
  });

  it('keeps the sole ACTIVE zone and leaves a conflicting STALE zone STALE', async () => {
    const active = makePickupZone('z1', 'zone A', ZoneStatus.ACTIVE, [
      'location_P1',
    ]);
    const stale = makePickupZone('z2', 'Lấy hànng', ZoneStatus.STALE, [
      'location_P1',
    ]);
    zoneRepo.find.mockResolvedValue([active, stale]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    const result = await service.sync();

    expect(result.markedStale).toBe(0);
    // Only the winning (ACTIVE) zone's location is pushed to the kernel.
    expect(kernelApi.putRawPlantModel).toHaveBeenCalledTimes(1);
    const pushed = kernelApi.putRawPlantModel.mock.calls[0][0] as {
      locations: Array<{ name: string }>;
    };
    expect(pushed.locations.map((location) => location.name)).toEqual([
      'location_P1',
    ]);
  });

  it('marks both zones STALE when two ACTIVE zones share a location', async () => {
    const a = makePickupZone('z1', 'zone A', ZoneStatus.ACTIVE, [
      'location_P1',
    ]);
    const b = makePickupZone('z2', 'Lấy hànng', ZoneStatus.ACTIVE, [
      'location_P1',
    ]);
    zoneRepo.find.mockResolvedValue([a, b]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    const result = await service.sync();

    expect(result.markedStale).toBe(2);
    expect(result.markedActive).toBe(0);
    expect(zoneRepo.update).toHaveBeenCalledTimes(1);
    expect(zoneRepo.update).toHaveBeenCalledWith(
      { id: In(['z1', 'z2']) },
      { status: ZoneStatus.STALE },
    );
    expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
  });

  it('falls back to STALE when the kernel rejects the repair write (read-only / OPERATING)', async () => {
    const zone = makeZone({
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P1', 0), makeMember('location_P2', 1)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1', 'P2'], locations: [] }),
    );
    kernelApi.putRawPlantModel.mockRejectedValue(new Error('OPERATING'));

    const result = await service.sync();

    expect(result.markedStale).toBe(1);
    expect(result.markedActive).toBe(0);
    expect(kernelApi.putRawPlantModel).toHaveBeenCalledTimes(1);
    expect(zoneRepo.update).toHaveBeenCalledWith(
      { id: In([zone.id]) },
      { status: ZoneStatus.STALE },
    );
  });

  it('marks an ACTIVE zone STALE without writing when a member point is missing', async () => {
    const zone = makeZone({
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: [], locations: [] }),
    );

    const result = await service.sync();

    expect(result.markedStale).toBe(1);
    expect(zoneRepo.update).toHaveBeenCalledWith(
      { id: In([zone.id]) },
      { status: ZoneStatus.STALE },
    );
    expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
  });

  it('returns kernelUnreachable=true and skips sync when plant model is unavailable', async () => {
    kernelApi.getRawPlantModel.mockResolvedValue(null);

    const result = await service.sync();

    expect(result).toEqual({
      plantModelName: null,
      total: 0,
      markedStale: 0,
      markedActive: 0,
      skippedOtherMaps: 0,
      unassigned: 0,
      kernelUnreachable: true,
    });
    expect(zoneRepo.find).not.toHaveBeenCalled();
    expect(zoneRepo.save).not.toHaveBeenCalled();
  });

  it('leaves a zone belonging to another map completely untouched', async () => {
    const otherMap = makeZone({
      id: 'z-other',
      plantModelName: 'another-map',
      mapRecordId: 'other-record',
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([otherMap]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    const result = await service.sync();

    expect(result.total).toBe(0);
    expect(result.skippedOtherMaps).toBe(1);
    expect(result.markedStale).toBe(0);
    expect(zoneRepo.save).not.toHaveBeenCalled();
    expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
  });

  it('never pushes another map’s locations into the loaded map', async () => {
    const loaded = makeZone({
      id: 'z-loaded',
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P1', 0)],
    });
    const otherMap = makeZone({
      id: 'z-other',
      plantModelName: 'another-map',
      mapRecordId: 'other-record',
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P2', 0)],
    });
    zoneRepo.find.mockResolvedValue([loaded, otherMap]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1', 'P2'], locations: [] }),
    );

    await service.sync();

    expect(kernelApi.putRawPlantModel).toHaveBeenCalledTimes(1);
    const pushed = kernelApi.putRawPlantModel.mock.calls[0][0] as {
      locations: Array<{ name: string }>;
    };
    expect(pushed.locations.map((location) => location.name)).toEqual([
      'location_P1',
    ]);
  });

  it('never claims an unassigned zone, even when all its points exist here', async () => {
    const unassigned = makeZone({
      plantModelName: null,
      mapRecordId: null,
      status: ZoneStatus.ACTIVE,
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([unassigned]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    const result = await service.sync();

    expect(result.unassigned).toBe(1);
    expect(result.total).toBe(0);
    expect(result.skippedOtherMaps).toBe(0);
    expect(unassigned.plantModelName).toBeNull();
    expect(zoneRepo.save).not.toHaveBeenCalled();
    expect(kernelApi.putRawPlantModel).not.toHaveBeenCalled();
  });
});

describe('ZoneService.assignToLoadedMap', () => {
  let service: ZoneService;
  let zoneRepo: RepoMock;
  let kernelApi: { getRawPlantModel: jest.Mock };
  let activeMapRecords: { resolveId: jest.Mock };

  beforeEach(async () => {
    zoneRepo = makeRepo();
    kernelApi = { getRawPlantModel: jest.fn() };
    activeMapRecords = {
      resolveId: jest.fn().mockResolvedValue(ACTIVE_RECORD_ID),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneService,
        { provide: getDataSourceToken(), useValue: { query: jest.fn() } },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: getRepositoryToken(ZoneMemberEntity), useValue: makeRepo() },
        { provide: KernelApiService, useValue: kernelApi },
        ZoneLocationWriter,
        PlantModelWriter,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
        ZoneUsageQuery,
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
        {
          provide: ActiveMapContext,
          useValue: { id: activeMapRecords.resolveId },
        },
        {
          provide: getRepositoryToken(CargoEntity),
          useValue: {
            createQueryBuilder: jest.fn(() => ({
              select: jest.fn().mockReturnThis(),
              addSelect: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              groupBy: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            })),
          },
        },
      ],
    }).compile();

    service = module.get(ZoneService);
  });

  it('stamps the loaded map record onto the requested zones', async () => {
    const zone = makeZone({
      plantModelName: null,
      mapRecordId: null,
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    const result = await service.assignToLoadedMap(['zone-1']);

    expect(result).toEqual({ plantModelName: 'runtime-map', assigned: 1 });
    expect(zone.plantModelName).toBe('runtime-map');
    expect(zone.mapRecordId).toBe(ACTIVE_RECORD_ID);
  });

  it('refuses a zone whose points are not on the loaded map', async () => {
    const zone = makeZone({
      plantModelName: null,
      mapRecordId: null,
      members: [makeMember('location_P9', 0)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    await expect(service.assignToLoadedMap(['zone-1'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(zoneRepo.update).not.toHaveBeenCalled();
  });

  it('reassigns a zone that was stamped with the wrong map', async () => {
    const zone = makeZone({
      plantModelName: 'wrong-map',
      mapRecordId: 'wrong-record',
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    await service.assignToLoadedMap(['zone-1']);

    expect(zone.plantModelName).toBe('runtime-map');
    expect(zone.mapRecordId).toBe(ACTIVE_RECORD_ID);
  });

  it('refuses with 409 when a zone of the same name already lives on the loaded map', async () => {
    const zone = makeZone({
      plantModelName: null,
      mapRecordId: null,
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    zoneRepo.findOne.mockResolvedValue(
      makeZone({ id: 'other-zone', mapRecordId: ACTIVE_RECORD_ID }),
    );
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    await expect(service.assignToLoadedMap(['zone-1'])).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(zoneRepo.update).not.toHaveBeenCalled();
  });

  it('turns a unique-name violation of the bulk update into 409', async () => {
    const zone = makeZone({
      plantModelName: null,
      mapRecordId: null,
      members: [makeMember('location_P1', 0)],
    });
    zoneRepo.find.mockResolvedValue([zone]);
    zoneRepo.update.mockRejectedValue(
      Object.assign(new QueryFailedError('UPDATE', [], new Error('dup')), {
        driverError: { code: '23505' },
      }),
    );
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    await expect(service.assignToLoadedMap(['zone-1'])).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses to assign when the loaded map does not resolve to a library record (external/unknown)', async () => {
    activeMapRecords.resolveId.mockResolvedValue(null);
    const zone = makeZone({ members: [makeMember('location_P1', 0)] });
    zoneRepo.find.mockResolvedValue([zone]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({ pointNames: ['P1'], locations: [] }),
    );

    await expect(service.assignToLoadedMap(['zone-1'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(zoneRepo.save).not.toHaveBeenCalled();
  });
});

describe('ZoneService.create', () => {
  let service: ZoneService;
  let zoneRepo: RepoMock & { findOneOrFail: jest.Mock };
  let kernelApi: {
    invalidatePlantModelCache: jest.Mock;
    getRawPlantModel: jest.Mock;
    putRawPlantModel: jest.Mock;
    getVehicleStates: jest.Mock;
    setVehicleAdapterEnabled: jest.Mock;
    setVehicleIntegrationLevel: jest.Mock;
  };
  let activeMapRecords: { resolveId: jest.Mock };
  let zoneEntityCreate: jest.Mock;
  let memberRepo: RepoMock;

  beforeEach(async () => {
    zoneRepo = {
      ...makeRepo(),
      findOneOrFail: jest.fn((opts: { where: { id: string } }) =>
        Promise.resolve(makeZone({ id: opts.where.id, type: ZoneType.PICKUP })),
      ),
    };
    zoneRepo.find.mockResolvedValue([]); // pickDefaultColor()'s lookup of existing zone colors
    kernelApi = {
      invalidatePlantModelCache: jest.fn(),
      getRawPlantModel: jest.fn(),
      putRawPlantModel: jest.fn().mockResolvedValue(undefined),
      getVehicleStates: jest.fn().mockResolvedValue([]),
      setVehicleAdapterEnabled: jest.fn().mockResolvedValue(undefined),
      setVehicleIntegrationLevel: jest.fn().mockResolvedValue(undefined),
    };
    activeMapRecords = {
      resolveId: jest.fn().mockResolvedValue(ACTIVE_RECORD_ID),
    };

    memberRepo = makeRepo();
    zoneEntityCreate = jest.fn((v: unknown) => v);
    const dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb({
          getRepository: (entity: unknown) =>
            entity === ZoneEntity
              ? {
                  create: zoneEntityCreate,
                  findOne: jest.fn().mockResolvedValue(null),
                  save: (v: { id?: string }) => ({ id: 'zone-1', ...v }),
                }
              : {
                  create: (v: unknown) => v,
                  find: jest.fn().mockResolvedValue([]),
                  save: (v: unknown[]) => v,
                },
          query: jest.fn(),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: getRepositoryToken(ZoneMemberEntity), useValue: memberRepo },
        { provide: KernelApiService, useValue: kernelApi },
        ZoneLocationWriter,
        PlantModelWriter,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
        ZoneUsageQuery,
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
        {
          provide: ActiveMapContext,
          useValue: { id: activeMapRecords.resolveId },
        },
        {
          provide: getRepositoryToken(CargoEntity),
          useValue: { createQueryBuilder: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ZoneService);
  });

  it('stamps a new PICKUP zone with the currently active map record', async () => {
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({
        pointNames: ['P1'],
        locations: [{ name: 'location_P1', links: ['P1'] }],
      }),
    );

    await service.create({
      name: 'Pickup A',
      type: ZoneType.PICKUP,
      members: [{ locationName: 'location_P1', positionIndex: 0 }],
    });

    expect(zoneEntityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mapRecordId: ACTIVE_RECORD_ID }),
    );
  });

  it('stores operation and maxVehicles when provided at creation', async () => {
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({
        pointNames: ['P1'],
        locations: [{ name: 'location_P1', links: ['P1'] }],
      }),
    );

    await service.create({
      name: 'Pickup A',
      type: ZoneType.PICKUP,
      operation: 'Charge',
      maxVehicles: 2,
      members: [{ locationName: 'location_P1', positionIndex: 0 }],
    });

    expect(zoneEntityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'Charge', maxVehicles: 2 }),
    );
  });

  it('rejects a duplicate zone name within the active map', async () => {
    zoneRepo.findOne.mockResolvedValue(
      makeZone({ id: 'existing-zone', name: 'Pickup A' }),
    );
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({
        pointNames: ['P1'],
        locations: [{ name: 'location_P1', links: ['P1'] }],
      }),
    );

    await expect(
      service.create({
        name: 'Pickup A',
        type: ZoneType.PICKUP,
        members: [{ locationName: 'location_P1', positionIndex: 0 }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(zoneEntityCreate).not.toHaveBeenCalled();
  });

  it('rejects a location already assigned to another active zone in the same map', async () => {
    memberRepo.find.mockResolvedValue([
      {
        locationName: 'location_P1',
        zoneId: 'existing-zone',
        zone: makeZone({ id: 'existing-zone', mapRecordId: ACTIVE_RECORD_ID }),
      },
    ]);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({
        pointNames: ['P1'],
        locations: [{ name: 'location_P1', links: ['P1'] }],
      }),
    );

    await expect(
      service.create({
        name: 'Pickup B',
        type: ZoneType.PICKUP,
        members: [{ locationName: 'location_P1', positionIndex: 0 }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(zoneEntityCreate).not.toHaveBeenCalled();
  });

  it('rejects unresolved maps before saving a new zone', async () => {
    activeMapRecords.resolveId.mockResolvedValue(null);
    kernelApi.getRawPlantModel.mockResolvedValue(
      makePlantModel({
        pointNames: ['P1'],
        locations: [{ name: 'location_P1', links: ['P1'] }],
      }),
    );

    await expect(
      service.create({
        name: 'Pickup A',
        type: ZoneType.PICKUP,
        members: [{ locationName: 'location_P1', positionIndex: 0 }],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(zoneEntityCreate).not.toHaveBeenCalled();
  });
});

describe('ZoneService.update', () => {
  let service: ZoneService;
  let zoneRepo: RepoMock & { findOne: jest.Mock };

  beforeEach(async () => {
    zoneRepo = { ...makeRepo(), findOne: jest.fn() };
    zoneRepo.findOne.mockResolvedValue(makeZone());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneService,
        { provide: getDataSourceToken(), useValue: {} },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: getRepositoryToken(ZoneMemberEntity), useValue: makeRepo() },
        {
          provide: KernelApiService,
          useValue: {
            getRawPlantModel: jest.fn(),
            putRawPlantModel: jest.fn(),
          },
        },
        ZoneLocationWriter,
        PlantModelWriter,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
        ZoneUsageQuery,
        {
          provide: ActiveMapRecordService,
          useValue: {
            resolveId: jest.fn().mockResolvedValue(ACTIVE_RECORD_ID),
          },
        },
        {
          provide: ActiveMapContext,
          useValue: fixedActiveMap(ACTIVE_RECORD_ID),
        },
        {
          provide: getRepositoryToken(CargoEntity),
          useValue: { createQueryBuilder: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ZoneService);
  });

  it('renames a zone when name is provided', async () => {
    await service.update('zone-1', { name: 'Kho mới' });

    expect(zoneRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Kho mới' }),
    );
  });

  it('rejects renaming to another zone name in the same map', async () => {
    zoneRepo.findOne
      .mockResolvedValueOnce(makeZone({ id: 'zone-1', name: 'Old name' }))
      .mockResolvedValueOnce(makeZone({ id: 'zone-2', name: 'Taken' }));

    await expect(
      service.update('zone-1', { name: 'Taken' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(zoneRepo.save).not.toHaveBeenCalled();
  });

  it('turns a concurrent duplicate caught by the unique index into a conflict', async () => {
    zoneRepo.findOne
      .mockResolvedValueOnce(makeZone({ id: 'zone-1', name: 'Old name' }))
      .mockResolvedValueOnce(null);
    zoneRepo.save.mockRejectedValueOnce(
      new QueryFailedError('UPDATE zones', [], { code: '23505' } as never),
    );

    await expect(
      service.update('zone-1', { name: 'Taken' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates color when provided, independently of name', async () => {
    await service.update('zone-1', { color: '#abcdef' });

    expect(zoneRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ color: '#abcdef', name: 'Dropoff A' }),
    );
  });

  it('updates both name and color together', async () => {
    await service.update('zone-1', { name: 'Kho mới', color: '#abcdef' });

    expect(zoneRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Kho mới', color: '#abcdef' }),
    );
  });

  it('leaves the existing name untouched when name is omitted', async () => {
    await service.update('zone-1', { color: '#abcdef' });

    const saved = zoneRepo.save.mock.calls[0][0] as ZoneEntity;
    expect(saved.name).toBe('Dropoff A');
  });

  it('persists a per-zone operation override', async () => {
    await service.update('zone-1', { operation: 'Charge' });

    expect(zoneRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'Charge' }),
    );
  });

  it('persists a maxVehicles cap', async () => {
    await service.update('zone-1', { maxVehicles: 3 });

    expect(zoneRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ maxVehicles: 3 }),
    );
  });

  it('explicitly clears maxVehicles when given null, distinct from omitting it', async () => {
    zoneRepo.findOne.mockResolvedValue(makeZone({ maxVehicles: 5 }));

    await service.update('zone-1', { maxVehicles: null });

    expect(zoneRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ maxVehicles: null }),
    );
  });

  it('leaves maxVehicles untouched when omitted entirely', async () => {
    zoneRepo.findOne.mockResolvedValue(makeZone({ maxVehicles: 5 }));

    await service.update('zone-1', { name: 'Kho mới' });

    const saved = zoneRepo.save.mock.calls[0][0] as ZoneEntity;
    expect(saved.maxVehicles).toBe(5);
  });

  it("rejects an update outside the caller's map scope", async () => {
    zoneRepo.findOne.mockResolvedValue(
      makeZone({ mapRecordId: 'other-record' }),
    );

    await expect(
      service.update('zone-1', { name: 'Kho mới' }, ['some-other-record']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(zoneRepo.save).not.toHaveBeenCalled();
  });
});

describe('ZoneService.list', () => {
  let service: ZoneService;
  let zoneRepo: RepoMock;
  let activeMapRecords: { resolveId: jest.Mock };

  beforeEach(async () => {
    zoneRepo = makeRepo();
    zoneRepo.find.mockResolvedValue([]);
    activeMapRecords = {
      resolveId: jest.fn().mockResolvedValue(ACTIVE_RECORD_ID),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneService,
        { provide: getDataSourceToken(), useValue: { query: jest.fn() } },
        { provide: getRepositoryToken(ZoneEntity), useValue: zoneRepo },
        { provide: getRepositoryToken(ZoneMemberEntity), useValue: makeRepo() },
        {
          provide: KernelApiService,
          useValue: { getRawPlantModel: jest.fn() },
        },
        ZoneLocationWriter,
        PlantModelWriter,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
            emitAsync: jest.fn().mockResolvedValue([]),
          },
        },
        ZoneUsageQuery,
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
        {
          provide: ActiveMapContext,
          useValue: { id: activeMapRecords.resolveId },
        },
        {
          provide: getRepositoryToken(CargoEntity),
          useValue: {
            createQueryBuilder: jest.fn(() => ({
              select: jest.fn().mockReturnThis(),
              addSelect: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              groupBy: jest.fn().mockReturnThis(),
              getRawMany: jest.fn().mockResolvedValue([]),
            })),
          },
        },
      ],
    }).compile();

    service = module.get(ZoneService);
  });

  it('scopes the loaded-map query at the database, not by loading every zone into memory', async () => {
    await service.list({ allMaps: false });

    expect(activeMapRecords.resolveId).toHaveBeenCalled();
    expect(zoneRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mapRecordId: ACTIVE_RECORD_ID } }),
    );
  });

  it('never queries at all — no unscoped fallback — when the loaded map has no resolved record', async () => {
    activeMapRecords.resolveId.mockResolvedValue(null);

    const result = await service.list({ allMaps: false });

    expect(result).toEqual([]);
    expect(zoneRepo.find).not.toHaveBeenCalled();
  });

  it('does not filter by map at all when allMaps is requested', async () => {
    await service.list({ allMaps: true });

    expect(zoneRepo.find).toHaveBeenCalledWith(
      expect.not.objectContaining({ where: expect.anything() }),
    );
    expect(activeMapRecords.resolveId).not.toHaveBeenCalled();
  });
});
