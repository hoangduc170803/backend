import { NotFoundException } from '@nestjs/common';
import { OperatingCargoService } from './operating-cargo.service';
import type { CargoService } from '../../cargo/cargo.service';
import { CargoStatus } from '../../cargo/entities/cargo.entity';
import { TaskStatus } from '../../cargo/entities/transport-task.entity';

function storedCargo() {
  return {
    id: 'cargo-1',
    itemCode: 'BOX-1',
    status: CargoStatus.ACTIVE,
    taskStatus: null,
    assignedVehicleName: null,
    sourceZoneId: 'zone-src',
    sourcePointName: 'P1',
    sourcePickupLocationName: 'LOC-1',
    destinationZoneId: 'zone-dst',
    destinationLocationName: null,
    reservedLocationName: null,
    slotDecisionSeq: 0,
    mapRecordId: 'map-a',
    blockedReason: null,
    visual: { state: 'AT_SOURCE', pointName: null },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  } as unknown as Awaited<ReturnType<CargoService['findOne']>>;
}

function makeService(activeMapRecordId: string | null) {
  const cargo = {
    list: jest
      .fn()
      .mockResolvedValue({ cargos: [], total: 0, truncated: false }),
    create: jest.fn().mockResolvedValue({ id: 'cargo-1' }),
    findOne: jest.fn().mockResolvedValue(storedCargo()),
    remove: jest.fn().mockResolvedValue({ message: 'Cargo deleted.' }),
    removeManyOnMap: jest.fn((ids: string[]) =>
      Promise.resolve(
        [...new Set(ids)].map((cargoId) => ({
          cargoId,
          reason: null as string | null,
        })),
      ),
    ),
  };
  const activeMap = { id: jest.fn().mockResolvedValue(activeMapRecordId) };
  const service = new OperatingCargoService(
    cargo as unknown as CargoService,
    activeMap as never,
    {
      namesOf: jest.fn().mockResolvedValue(new Map([['map-a', 'Map A']])),
    } as never,
  );
  return { service, cargo, activeMap };
}

const FORBIDDEN =
  'Vai trò của bạn không được gán quyền thao tác trên bản đồ đang tải.';

describe('OperatingCargoService AUTH-3 map scope', () => {
  describe('list', () => {
    it("returns an empty page (not a throw) when the active map falls outside the caller's scope", async () => {
      const { service } = makeService('map-a');
      await expect(service.list({}, ['map-b'])).resolves.toEqual({
        cargos: [],
        total: 0,
        truncated: false,
      });
    });

    it('returns an empty page when no map is active at all and the caller is scoped', async () => {
      const { service } = makeService(null);
      await expect(service.list({}, ['map-b'])).resolves.toEqual({
        cargos: [],
        total: 0,
        truncated: false,
      });
    });

    it('proceeds normally when the active map is within scope', async () => {
      const { service, cargo } = makeService('map-a');
      await service.list({}, ['map-a', 'map-b']);
      expect(cargo.list).toHaveBeenCalled();
    });

    it('asks for the loaded map only, with cancelled cargo filtered in SQL so total matches', async () => {
      const { service, cargo } = makeService('map-a');
      await service.list({}, undefined);
      expect(cargo.list).toHaveBeenCalledWith(expect.anything(), {
        mapIds: ['map-a'],
        excludeCancelled: true,
      });
    });

    it('reads every map for scope=all, and tags rows with their map', async () => {
      const { service, cargo } = makeService('map-a');
      cargo.list.mockResolvedValue({
        cargos: [
          { ...storedCargo(), taskStatus: null, assignedVehicleName: null },
          {
            ...storedCargo(),
            id: 'cargo-2',
            mapRecordId: null,
            taskStatus: null,
            assignedVehicleName: null,
          },
        ],
        total: 2,
        truncated: false,
      });

      const list = await service.list({ scope: 'all' }, undefined);

      expect(cargo.list).toHaveBeenCalledWith(expect.anything(), {
        mapIds: null,
        excludeCancelled: true,
      });
      expect(list.total).toBe(2);
      expect(list.cargos.map((c) => [c.mapName, c.onLoadedMap])).toEqual([
        ['Map A', true],
        [null, false],
      ]);
    });

    it('is unaffected when mapIds is undefined (unrestricted — regression guard)', async () => {
      const { service, cargo } = makeService(null);
      await service.list({}, undefined);
      expect(cargo.list).toHaveBeenCalled();
    });
  });

  describe('mutating methods throw Forbidden when the active map is out of scope', () => {
    it('create', async () => {
      const { service } = makeService('map-a');
      await expect(
        service.create(
          {
            pickupAreaWesId: 'zone-src',
            pickupPointName: 'P1',
            targetStoreAreaWesId: 'zone-dst',
          },
          'user-1',
          ['map-b'],
        ),
      ).rejects.toThrow(FORBIDDEN);
    });

    it('cancel', async () => {
      const { service } = makeService('map-a');
      await expect(service.cancel('cargo-1', ['map-b'])).rejects.toThrow(
        FORBIDDEN,
      );
    });
  });

  describe('mutating methods proceed when the active map is in scope, or the caller is unrestricted', () => {
    it('create — in scope', async () => {
      const { service, cargo } = makeService('map-a');
      await service.create(
        {
          pickupAreaWesId: 'zone-src',
          pickupPointName: 'P1',
          targetStoreAreaWesId: 'zone-dst',
        },
        'user-1',
        ['map-a'],
      );
      expect(cargo.create).toHaveBeenCalled();
    });

    it('create — unrestricted (mapIds undefined)', async () => {
      const { service, cargo } = makeService('map-a');
      await service.create(
        {
          pickupAreaWesId: 'zone-src',
          pickupPointName: 'P1',
          targetStoreAreaWesId: 'zone-dst',
        },
        'user-1',
        undefined,
      );
      expect(cargo.create).toHaveBeenCalled();
    });

    it('cancel — in scope', async () => {
      const { service, cargo } = makeService('map-a');
      await service.cancel('cargo-1', ['map-a']);
      expect(cargo.remove).toHaveBeenCalledWith('cargo-1', 'map-a');
    });
  });

  describe('cancelMany', () => {
    it('hands the whole batch to one bulk removal on the loaded map', async () => {
      const { service, cargo, activeMap } = makeService('map-a');

      await service.cancelMany(['cargo-1', 'cargo-2', 'cargo-3'], ['map-a']);

      expect(activeMap.id).toHaveBeenCalledTimes(1);
      expect(cargo.removeManyOnMap).toHaveBeenCalledTimes(1);
      expect(cargo.removeManyOnMap).toHaveBeenCalledWith(
        ['cargo-1', 'cargo-2', 'cargo-3'],
        'map-a',
      );
      expect(cargo.remove).not.toHaveBeenCalled();
    });

    it('reports each cargo as deleted or failed with its reason', async () => {
      const { service, cargo } = makeService('map-a');
      cargo.removeManyOnMap.mockResolvedValueOnce([
        { cargoId: 'cargo-1', reason: 'Xe V1 đang nâng hàng' },
        { cargoId: 'cargo-2', reason: null },
      ]);

      const { results } = await service.cancelMany(
        ['cargo-1', 'cargo-2'],
        undefined,
      );

      expect(results).toEqual([
        {
          cargoId: 'cargo-1',
          outcome: 'failed',
          reason: 'Xe V1 đang nâng hàng',
        },
        { cargoId: 'cargo-2', outcome: 'deleted', reason: null },
      ]);
    });

    it('refuses the whole batch when the loaded map is out of scope', async () => {
      const { service, cargo } = makeService('map-a');

      await expect(service.cancelMany(['cargo-1'], ['map-b'])).rejects.toThrow(
        FORBIDDEN,
      );
      expect(cargo.removeManyOnMap).not.toHaveBeenCalled();
    });
  });

  it('cancel refuses a cargo that belongs to a map other than the loaded one', async () => {
    const { service, cargo } = makeService('map-b');
    await expect(service.cancel('cargo-1', undefined)).rejects.toThrow(
      NotFoundException,
    );
    expect(cargo.remove).not.toHaveBeenCalled();
  });

  it('lists a cargo failed by a lost vehicle as FAILED with its reason, not as queued', async () => {
    const { service, cargo } = makeService('map-a');
    cargo.list.mockResolvedValue({
      cargos: [
        {
          ...storedCargo(),
          status: CargoStatus.FAILED,
          taskStatus: TaskStatus.CANCELLED,
          assignedVehicleName: 'V1',
          blockedReason: 'Xe V1 mất kết nối',
          visual: { state: 'ON_AGV', pointName: null, vehicleName: 'V1' },
        },
      ],
      total: 1,
      truncated: false,
    });

    const { cargos } = await service.list({}, undefined);

    expect(cargos[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'Xe V1 mất kết nối',
    });
  });

  it('exposes reservation and commit details for the operating slot layer', async () => {
    const { service, cargo } = makeService('map-a');
    cargo.list.mockResolvedValue({
      cargos: [
        {
          ...storedCargo(),
          reservedLocationName: 'location_3168',
          destinationLocationName: null,
          slotDecisionSeq: 7,
        },
      ],
      total: 1,
      truncated: false,
    });

    const { cargos } = await service.list({}, undefined);

    expect(cargos[0]).toMatchObject({
      reservedLocationName: 'location_3168',
      destinationLocationName: null,
      slotDecisionSeq: 7,
    });
  });
});
