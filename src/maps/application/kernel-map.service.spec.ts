import { ActiveMapRecordService } from '../infrastructure/active-map-record.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { KernelMapService } from './kernel-map.service';
import { MapRecordEntity } from '../infrastructure/entities/map-record.entity';
import { CargoEntity } from '../../cargo/entities/cargo.entity';
import { ZoneEntity } from '../../zones/entities/zone.entity';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { TransportOrderService } from '../../opentcs/transport-order.service';
import { VehicleStateStore } from '../../opentcs/vehicle-state.store';

type RepoMock = {
  find: jest.Mock;
  findOne: jest.Mock;
};

function makeRepo(): RepoMock {
  return { find: jest.fn(), findOne: jest.fn() };
}

describe('KernelMapService', () => {
  let service: KernelMapService;
  let mapRepo: RepoMock;
  let kernelApi: {
    getRawPlantModel: jest.Mock;
    getPlantModelName: jest.Mock;
    isReachable: jest.Mock;
    getKernelState: jest.Mock;
  };

  beforeEach(async () => {
    mapRepo = makeRepo();
    kernelApi = {
      getRawPlantModel: jest.fn(),
      getPlantModelName: jest.fn().mockResolvedValue(null),
      isReachable: jest.fn(),
      getKernelState: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KernelMapService,
        {
          provide: ActiveMapRecordService,
          useValue: {
            resolve: () => mapRepo.findOne() as Promise<MapRecordEntity | null>,
            resolveId: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: KernelApiService, useValue: kernelApi },
        {
          provide: TransportOrderService,
          useValue: new TransportOrderService(
            kernelApi as unknown as KernelApiService,
          ),
        },
        { provide: VehicleStateStore, useValue: { get: jest.fn() } },
        { provide: getRepositoryToken(MapRecordEntity), useValue: mapRepo },
        { provide: getRepositoryToken(CargoEntity), useValue: makeRepo() },
        { provide: getRepositoryToken(ZoneEntity), useValue: makeRepo() },
      ],
    }).compile();

    service = module.get(KernelMapService);
  });

  describe('getCurrent', () => {
    it('returns null when kernel has no runtime plant model', async () => {
      kernelApi.getRawPlantModel.mockResolvedValue(null);

      await expect(service.getCurrent()).resolves.toBeNull();
      expect(mapRepo.findOne).not.toHaveBeenCalled();
    });

    it('returns runtime counts from kernel and enriches with verified active record metadata', async () => {
      kernelApi.getRawPlantModel.mockResolvedValue({
        name: 'v7',
        points: [{ name: 'P1' }, { name: 'P2' }],
        paths: [{ name: 'path-1' }],
        vehicles: [{ name: 'AGV-01' }, { name: 'AGV-02' }],
      });
      mapRepo.findOne.mockResolvedValue({
        id: 'map-1',
        name: 'v7',
        originalFilename: 'v7.xml',
        pointCount: 504,
        pathCount: 703,
        vehicleCount: 10,
        uploadedAt: new Date('2026-06-25T12:12:00.000Z'),
        uploadedById: 'user-1',
      });

      await expect(service.getCurrent()).resolves.toEqual({
        name: 'v7',
        pointCount: 2,
        pathCount: 1,
        vehicleCount: 2,
        originalFilename: 'v7.xml',
        uploadedAt: new Date('2026-06-25T12:12:00.000Z'),
        uploadedById: 'user-1',
      });
      expect(mapRepo.findOne).toHaveBeenCalledWith();
    });
  });
});
