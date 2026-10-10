import { In } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgvsService } from './agvs.service';
import { AgvEntity } from './entities/agv.entity';
import { ActiveMapRecordService } from '../maps/infrastructure/active-map-record.service';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';

type MockRepo = {
  find: jest.Mock;
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  delete: jest.Mock;
  update: jest.Mock;
};

const makeAgv = (overrides: Partial<AgvEntity> = {}): AgvEntity => ({
  id: 'agv-1',
  code: 'AGV-001',
  name: 'AGV 1',
  model: null,
  manufacturer: null,
  serialNumber: null,
  initialPosition: null,
  isDispatchEnabled: true,
  isIgnored: false,
  criticalBatteryThreshold: 20,
  sufficientBatteryThreshold: 60,
  goodBatteryThreshold: 50,
  fullBatteryThreshold: 95,
  config: {},
  plantModelName: null,
  mapRecordId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  createdById: 'user-1',
  ...overrides,
});

describe('AgvsService', () => {
  let service: AgvsService;
  let repo: MockRepo;
  let kernelApi: {
    getVehicles: jest.Mock;
    getVehicleStates: jest.Mock;
    getPlantModelName: jest.Mock;
    setVehicleIntegrationLevel: jest.Mock;
    setVehicleAdapterEnabled: jest.Mock;
  };
  let vehicleStore: {
    getAll: jest.Mock;
    get: jest.Mock;
    isConnected: jest.Mock;
  };
  let activeMapRecords: { resolveId: jest.Mock };

  beforeEach(async () => {
    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo.find.mockImplementation(
      async (options: { where?: { id?: { value?: unknown } } }) => {
        const ids = options.where?.id?.value;
        if (!Array.isArray(ids)) return [];
        const found: unknown[] = [];
        for (const id of ids) {
          const agv: unknown = await repo.findOne({ where: { id } });
          if (agv) found.push(agv);
        }
        return found;
      },
    );
    kernelApi = {
      getVehicles: jest.fn(),
      getVehicleStates: jest.fn().mockResolvedValue([]),
      getPlantModelName: jest.fn().mockResolvedValue(null),
      setVehicleIntegrationLevel: jest.fn().mockResolvedValue(undefined),
      setVehicleAdapterEnabled: jest.fn().mockResolvedValue(undefined),
    };
    // Kernel status is derived from the SSE-backed VehicleStateStore, not a
    // REST call. Default to reachable/empty; individual tests override.
    vehicleStore = {
      getAll: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
    };
    // The fingerprint-verified map record id — the authoritative scoping key now.
    // `getPlantModelName` stays mocked alongside it purely as display metadata.
    activeMapRecords = {
      resolveId: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgvsService,
        { provide: getRepositoryToken(AgvEntity), useValue: repo },
        { provide: KernelApiService, useValue: kernelApi },
        { provide: VehicleStateStore, useValue: vehicleStore },
        { provide: ActiveMapRecordService, useValue: activeMapRecords },
      ],
    }).compile();

    service = module.get(AgvsService);
  });

  describe('list', () => {
    it('paginates results and reports kernel status', async () => {
      const agv = makeAgv();
      repo.findAndCount.mockResolvedValue([[agv], 1]);
      vehicleStore.getAll.mockReturnValue([
        { name: agv.name, integrationLevel: 'TO_BE_UTILIZED' },
      ]);

      const result = await service.list({ page: 1, limit: 10 });

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 }),
      );
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.agvs[0].kernelStatus).toBe('connected');
      expect(result.kernelReachable).toBe(true);
    });

    it('marks kernelStatus as unknown when kernel is unreachable', async () => {
      const agv = makeAgv();
      repo.findAndCount.mockResolvedValue([[agv], 1]);
      vehicleStore.isConnected.mockReturnValue(false);

      const result = await service.list();

      expect(result.kernelReachable).toBe(false);
      expect(result.agvs[0].kernelStatus).toBe('unknown');
    });

    it('marks kernelStatus as reachable when vehicle is not TO_BE_UTILIZED', async () => {
      const agv = makeAgv();
      repo.findAndCount.mockResolvedValue([[agv], 1]);
      vehicleStore.getAll.mockReturnValue([
        { name: agv.name, integrationLevel: 'TO_BE_IGNORED' },
      ]);

      const result = await service.list();

      expect(result.agvs[0].kernelStatus).toBe('reachable');
    });

    it('marks kernelStatus as unreachable when name does not match any kernel vehicle', async () => {
      const agv = makeAgv();
      repo.findAndCount.mockResolvedValue([[agv], 1]);
      vehicleStore.getAll.mockReturnValue([
        { name: 'OTHER-AGV', integrationLevel: 'TO_BE_UTILIZED' },
      ]);

      const result = await service.list();

      expect(result.agvs[0].kernelStatus).toBe('unreachable');
    });

    it('applies search filter across code and name', async () => {
      repo.findAndCount.mockResolvedValue([[], 0]);

      await service.list({ search: 'agv-1' });

      const callArg: { where?: unknown[] } = repo.findAndCount.mock.calls[0][0];
      expect(callArg.where).toHaveLength(2);
    });

    it('lists AGVs across every map, unscoped by the loaded plant model', async () => {
      const onMapA = makeAgv({ id: 'a', plantModelName: 'map-a' });
      const onMapB = makeAgv({ id: 'b', plantModelName: 'map-b' });
      const legacy = makeAgv({ id: 'c', plantModelName: null });
      repo.findAndCount.mockResolvedValue([[onMapA, onMapB, legacy], 3]);

      const result = await service.list();

      expect(kernelApi.getPlantModelName).not.toHaveBeenCalled();
      expect(result.agvs.map((a) => a.id)).toEqual(['a', 'b', 'c']);
      expect(result.total).toBe(3);
    });
  });

  describe('findOne', () => {
    it('returns the AGV with kernel status when found', async () => {
      const agv = makeAgv();
      repo.findOne.mockResolvedValue(agv);

      const result = await service.findOne(agv.id);

      expect(result.id).toBe(agv.id);
      expect(result.kernelStatus).toBe('unreachable');
    });

    it('throws NotFoundException when AGV does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('updates allowed fields and persists changes', async () => {
      const agv = makeAgv();
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const result = await service.update(agv.id, {
        name: 'AGV 1 Renamed',
      });

      expect(repo.save).toHaveBeenCalled();
      expect(result.name).toBe('AGV 1 Renamed');
    });

    it('updates all four battery thresholds', async () => {
      const agv = makeAgv();
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const result = await service.updateBatteryThresholds(agv.id, {
        criticalBatteryThreshold: 30,
        sufficientBatteryThreshold: 70,
        goodBatteryThreshold: 55,
        fullBatteryThreshold: 90,
      });

      expect(result.criticalBatteryThreshold).toBe(30);
      expect(result.sufficientBatteryThreshold).toBe(70);
      expect(result.goodBatteryThreshold).toBe(55);
      expect(result.fullBatteryThreshold).toBe(90);
    });

    it('rejects thresholds that break BR-01 without saving', async () => {
      repo.findOne.mockResolvedValue(makeAgv());

      await expect(
        service.updateBatteryThresholds('agv-1', {
          criticalBatteryThreshold: 30,
          sufficientBatteryThreshold: 15,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('validates a partial change against the stored thresholds', async () => {
      repo.findOne.mockResolvedValue(makeAgv());

      await expect(
        service.updateBatteryThresholds('agv-1', { fullBatteryThreshold: 50 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('copies changed thresholds to the same vehicle on every map', async () => {
      const agv = makeAgv();
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      await service.updateBatteryThresholds(agv.id, {
        goodBatteryThreshold: 40,
      });

      expect(repo.update).toHaveBeenCalledWith(
        { name: 'AGV 1' },
        {
          criticalBatteryThreshold: 20,
          goodBatteryThreshold: 40,
          sufficientBatteryThreshold: 60,
          fullBatteryThreshold: 95,
        },
      );
    });

    it('leaves battery thresholds out of the general AGV update', async () => {
      const agv = makeAgv();
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      await service.update(agv.id, { model: 'M2' });

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when AGV does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.update('missing', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException when renaming to an existing name', async () => {
      const agv = makeAgv({ id: 'agv-1', name: 'AGV 1' });
      const other = makeAgv({ id: 'agv-2', name: 'AGV 2' });
      repo.findOne.mockResolvedValueOnce(agv).mockResolvedValueOnce(other);

      await expect(service.update('agv-1', { name: 'AGV 2' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException when changing to an occupied initial position', async () => {
      const agv = makeAgv({
        id: 'agv-1',
        initialPosition: 'P-1',
        mapRecordId: 'rec-a',
      });
      const other = makeAgv({
        id: 'agv-2',
        initialPosition: 'P-2',
        mapRecordId: 'rec-a',
      });
      repo.findOne.mockResolvedValueOnce(agv).mockResolvedValueOnce(other);

      await expect(
        service.update('agv-1', { initialPosition: 'P-2' }),
      ).rejects.toThrow(ConflictException);
    });

    it('allows keeping the same name without conflict', async () => {
      const agv = makeAgv({ id: 'agv-1', name: 'AGV 1' });
      repo.findOne.mockResolvedValueOnce(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const result = await service.update('agv-1', { name: 'AGV 1' });

      expect(result.name).toBe('AGV 1');
    });
  });

  describe('create', () => {
    beforeEach(() => {
      repo.create.mockImplementation((input: unknown) => input);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));
    });

    it('throws ConflictException when code already exists', async () => {
      repo.findOne.mockResolvedValueOnce(makeAgv());

      await expect(
        service.create({ code: 'AGV-001', name: 'New AGV' }, 'user-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the same code already exists on the same map', async () => {
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      repo.findOne.mockResolvedValueOnce(
        makeAgv({ code: 'AGV-001', mapRecordId: 'rec-a' }),
      );

      await expect(
        service.create({ code: 'AGV-001', name: 'New AGV' }, 'user-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('allows the same code already registered under a different map', async () => {
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'New AGV' }]);
      repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      const result = await service.create(
        { code: 'AGV-001', name: 'New AGV' },
        'user-1',
      );

      expect(repo.findOne).toHaveBeenNthCalledWith(1, {
        where: { code: 'AGV-001', mapRecordId: 'rec-a' },
      });
      expect(result.mapRecordId).toBe('rec-a');
    });

    it('creates without checking the kernel when no map is currently loaded', async () => {
      repo.findOne.mockResolvedValue(null);
      kernelApi.getPlantModelName.mockResolvedValue(null);
      activeMapRecords.resolveId.mockResolvedValue(null);

      const result = await service.create(
        { code: 'AGV-002', name: 'New AGV' },
        'user-1',
      );

      expect(kernelApi.getVehicleStates).not.toHaveBeenCalled();
      expect(result.plantModelName).toBeNull();
      expect(result.mapRecordId).toBeNull();
    });

    it('throws BadRequestException when the loaded map does not know the vehicle name', async () => {
      repo.findOne.mockResolvedValue(null);
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'AGV-OTHER' }]);

      await expect(
        service.create({ code: 'AGV-002', name: 'New AGV' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('stamps the currently loaded map name and record id onto a newly created AGV', async () => {
      repo.findOne.mockResolvedValue(null);
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'New AGV' }]);

      const result = await service.create(
        { code: 'AGV-002', name: 'New AGV' },
        'user-1',
      );

      expect(result.plantModelName).toBe('map-a');
      expect(result.mapRecordId).toBe('rec-a');
    });

    it('allows the same vehicle name already registered under a different map', async () => {
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'New AGV' }]);
      // First findOne is the code-conflict check, second is the name-conflict
      // check scoped to rec-a — an existing row on a different map record id
      // never matches it.
      repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      const result = await service.create(
        { code: 'AGV-002', name: 'New AGV' },
        'user-1',
      );

      expect(result.mapRecordId).toBe('rec-a');
    });

    it('throws ConflictException when the same name already exists on the same map', async () => {
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'New AGV' }]);
      repo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeAgv({ name: 'New AGV', mapRecordId: 'rec-a' }),
        );

      await expect(
        service.create({ code: 'AGV-002', name: 'New AGV' }, 'user-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the initial position already exists on the same map', async () => {
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'New AGV' }]);
      repo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeAgv({ initialPosition: 'P-1', mapRecordId: 'rec-a' }),
        );

      await expect(
        service.create(
          { code: 'AGV-002', name: 'New AGV', initialPosition: 'P-1' },
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);

      expect(repo.findOne).toHaveBeenNthCalledWith(3, {
        where: { initialPosition: 'P-1', mapRecordId: 'rec-a' },
      });
    });

    it('allows the same initial position on a different map', async () => {
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'New AGV' }]);
      repo.findOne.mockImplementation(
        ({ where }: { where: { mapRecordId?: string } }) =>
          Promise.resolve(
            where.mapRecordId === 'other-record'
              ? makeAgv({ initialPosition: 'P-1', mapRecordId: 'other-record' })
              : null,
          ),
      );

      const result = await service.create(
        { code: 'AGV-002', name: 'New AGV', initialPosition: 'P-1' },
        'user-1',
      );

      expect(result.mapRecordId).toBe('rec-a');
      expect(repo.findOne).toHaveBeenNthCalledWith(3, {
        where: { initialPosition: 'P-1', mapRecordId: 'rec-a' },
      });
    });

    it('does not treat a same-named legacy AGV with no map as a conflict', async () => {
      // A legacy row (mapRecordId: null) exists for this name, but the
      // name-conflict lookup is scoped to the exact current map record now, so
      // it never matches — the mock returning null for both findOne calls
      // simulates the DB genuinely finding no row for that scoped query.
      kernelApi.getPlantModelName.mockResolvedValue('map-a');
      activeMapRecords.resolveId.mockResolvedValue('rec-a');
      kernelApi.getVehicleStates.mockResolvedValue([{ name: 'New AGV' }]);
      repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      const result = await service.create(
        { code: 'AGV-002', name: 'New AGV' },
        'user-1',
      );

      expect(repo.findOne).toHaveBeenNthCalledWith(2, {
        where: { name: 'New AGV', mapRecordId: 'rec-a' },
      });
      expect(result.mapRecordId).toBe('rec-a');
    });
  });

  describe('enable', () => {
    it('turns a disabled AGV back on without touching the kernel', async () => {
      const agv = makeAgv({ isDispatchEnabled: false, isIgnored: false });
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const result = await service.enable(agv.id);

      expect(result.acceptanceStatus).toBe('ENABLED');
      expect(result.isDispatchEnabled).toBe(true);
      expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the AGV is ignored', async () => {
      repo.findOne.mockResolvedValue(makeAgv({ isIgnored: true }));

      await expect(service.enable('agv-1')).rejects.toThrow(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws ConflictException when already enabled', async () => {
      repo.findOne.mockResolvedValue(makeAgv({ isDispatchEnabled: true }));

      await expect(service.enable('agv-1')).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when AGV does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.enable('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('disable', () => {
    it('stops an enabled AGV without touching the kernel', async () => {
      const agv = makeAgv({ isDispatchEnabled: true, isIgnored: false });
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const result = await service.disable(agv.id);

      expect(result.acceptanceStatus).toBe('DISABLED');
      expect(result.isDispatchEnabled).toBe(false);
      expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the AGV is ignored', async () => {
      repo.findOne.mockResolvedValue(makeAgv({ isIgnored: true }));

      await expect(service.disable('agv-1')).rejects.toThrow(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws ConflictException when already disabled', async () => {
      repo.findOne.mockResolvedValue(makeAgv({ isDispatchEnabled: false }));

      await expect(service.disable('agv-1')).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when AGV does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.disable('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('ignore', () => {
    it('sets the kernel to TO_BE_RESPECTED before persisting the flag', async () => {
      const agv = makeAgv({ isIgnored: false });
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const result = await service.ignore(agv.id);

      expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
        agv.name,
        'TO_BE_RESPECTED',
      );
      expect(result.acceptanceStatus).toBe('IGNORED');
      expect(result.isIgnored).toBe(true);
    });

    it('does not persist when the kernel call fails', async () => {
      const agv = makeAgv({ isIgnored: false });
      repo.findOne.mockResolvedValue(agv);
      kernelApi.setVehicleIntegrationLevel.mockRejectedValue(
        new Error('kernel down'),
      );

      await expect(service.ignore(agv.id)).rejects.toThrow('kernel down');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws ConflictException when already ignored', async () => {
      repo.findOne.mockResolvedValue(makeAgv({ isIgnored: true }));

      await expect(service.ignore('agv-1')).rejects.toThrow(ConflictException);
      expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when AGV does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.ignore('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restore', () => {
    it('sets the kernel to TO_BE_UTILIZED and re-enables dispatch', async () => {
      const agv = makeAgv({ isIgnored: true, isDispatchEnabled: false });
      repo.findOne.mockResolvedValue(agv);
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const result = await service.restore(agv.id);

      expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
        agv.name,
        'TO_BE_UTILIZED',
      );
      expect(result.acceptanceStatus).toBe('ENABLED');
      expect(result.isIgnored).toBe(false);
      expect(result.isDispatchEnabled).toBe(true);
    });

    it('does not persist when the kernel call fails', async () => {
      const agv = makeAgv({ isIgnored: true });
      repo.findOne.mockResolvedValue(agv);
      kernelApi.setVehicleIntegrationLevel.mockRejectedValue(
        new Error('kernel down'),
      );

      await expect(service.restore(agv.id)).rejects.toThrow('kernel down');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the AGV is not ignored', async () => {
      repo.findOne.mockResolvedValue(makeAgv({ isIgnored: false }));

      await expect(service.restore('agv-1')).rejects.toThrow(ConflictException);
      expect(kernelApi.setVehicleIntegrationLevel).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when AGV does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.restore('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('removeMany', () => {
    it('loads every AGV once and deletes the found ones in one statement', async () => {
      const a = makeAgv({ id: 'a1' });
      const b = makeAgv({ id: 'a2' });
      repo.find.mockResolvedValueOnce([a, b]);

      const { results } = await service.removeMany(['a1', 'a2', 'a2', 'x9']);

      expect(repo.find).toHaveBeenCalledTimes(1);
      expect(repo.delete).toHaveBeenCalledTimes(1);
      expect(repo.delete).toHaveBeenCalledWith({ id: In(['a1', 'a2']) });
      expect(results).toEqual([
        { id: 'a1', outcome: 'changed', reason: null },
        { id: 'a2', outcome: 'changed', reason: null },
        { id: 'x9', outcome: 'failed', reason: 'AGV không tồn tại.' },
      ]);
    });

    it('deletes nothing when no id matches', async () => {
      repo.find.mockResolvedValueOnce([]);

      const { results } = await service.removeMany(['x9']);

      expect(repo.delete).not.toHaveBeenCalled();
      expect(results[0].outcome).toBe('failed');
    });
  });

  describe('setConnectionMany', () => {
    it('connects every found AGV with one lookup and reports each outcome', async () => {
      repo.find.mockResolvedValueOnce([
        makeAgv({ id: 'a1', name: 'V1' }),
        makeAgv({ id: 'a2', name: 'V2' }),
      ]);
      kernelApi.setVehicleAdapterEnabled
        .mockRejectedValueOnce(new Error('kernel down'))
        .mockResolvedValue(undefined);

      const { results } = await service.setConnectionMany(
        ['a1', 'a2', 'x9'],
        true,
      );

      expect(repo.find).toHaveBeenCalledTimes(1);
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(results).toEqual([
        { id: 'a1', outcome: 'failed', reason: 'kernel down' },
        { id: 'a2', outcome: 'changed', reason: null },
        { id: 'x9', outcome: 'failed', reason: 'AGV không tồn tại.' },
      ]);
      expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
        'V2',
        'TO_BE_UTILIZED',
      );
    });

    it('disconnects by ignoring the vehicle before disabling its adapter', async () => {
      repo.find.mockResolvedValueOnce([makeAgv({ id: 'a1', name: 'V1' })]);

      await service.setConnectionMany(['a1'], false);

      expect(kernelApi.setVehicleIntegrationLevel).toHaveBeenCalledWith(
        'V1',
        'TO_BE_IGNORED',
      );
      expect(kernelApi.setVehicleAdapterEnabled).toHaveBeenCalledWith(
        'V1',
        false,
      );
    });
  });

  describe('setAcceptance', () => {
    const byId = (agvs: AgvEntity[]) => (options: { where: { id: string } }) =>
      Promise.resolve(agvs.find((a) => a.id === options.where.id) ?? null);

    it('reports a no-op as unchanged instead of failing the batch', async () => {
      repo.findOne.mockImplementation(
        byId([
          makeAgv({ id: 'a', isDispatchEnabled: true }),
          makeAgv({ id: 'b', isDispatchEnabled: false }),
        ]),
      );
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const { results } = await service.setAcceptance({
        ids: ['a', 'b'],
        action: 'disable',
      });

      expect(results).toEqual([
        { id: 'a', outcome: 'changed', reason: null },
        { id: 'b', outcome: 'unchanged', reason: 'AGV đã ngừng nhận việc.' },
      ]);
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('keeps going past an AGV the action cannot apply to', async () => {
      repo.findOne.mockImplementation(
        byId([
          makeAgv({ id: 'a', isIgnored: true }),
          makeAgv({ id: 'b', isDispatchEnabled: true }),
        ]),
      );
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const { results } = await service.setAcceptance({
        ids: ['a', 'b', 'missing'],
        action: 'disable',
      });

      expect(results.map((r) => r.outcome)).toEqual([
        'failed',
        'changed',
        'failed',
      ]);
      expect(results[0].reason).toContain('Khôi phục');
      expect(results[2].reason).toBe('AGV không tồn tại.');
    });

    it('reports a kernel failure per AGV without aborting the rest', async () => {
      repo.findOne.mockImplementation(
        byId([makeAgv({ id: 'a' }), makeAgv({ id: 'b' })]),
      );
      repo.save.mockImplementation((entity) => Promise.resolve(entity));
      kernelApi.setVehicleIntegrationLevel
        .mockRejectedValueOnce(new Error('kernel down'))
        .mockResolvedValueOnce(undefined);

      const { results } = await service.setAcceptance({
        ids: ['a', 'b'],
        action: 'ignore',
      });

      expect(results).toEqual([
        { id: 'a', outcome: 'failed', reason: 'kernel down' },
        { id: 'b', outcome: 'changed', reason: null },
      ]);
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('applies a repeated id only once', async () => {
      repo.findOne.mockImplementation(
        byId([makeAgv({ id: 'a', isDispatchEnabled: true })]),
      );
      repo.save.mockImplementation((entity) => Promise.resolve(entity));

      const { results } = await service.setAcceptance({
        ids: ['a', 'a'],
        action: 'disable',
      });

      expect(results).toHaveLength(1);
      expect(repo.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when AGV does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('removes the AGV when found', async () => {
      const agv = makeAgv();
      repo.findOne.mockResolvedValue(agv);

      await service.remove(agv.id);

      expect(repo.remove).toHaveBeenCalledWith(agv);
    });
  });
});
