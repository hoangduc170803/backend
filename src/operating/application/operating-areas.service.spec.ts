import { OperatingAreasService } from './operating-areas.service';
import type { ZoneService } from '../../zones/zone.service';
import type { KernelApiService } from '../../opentcs/kernel-api.service';

function makeService(activeMapRecordId: string | null) {
  const zones = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'zone-1' }),
    update: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    sync: jest.fn().mockResolvedValue({
      plantModelName: 'factory-a',
      total: 0,
      markedStale: 0,
      markedActive: 0,
      skippedOtherMaps: 0,
      unassigned: 0,
      kernelUnreachable: false,
    }),
    activeMapRecordId: jest.fn().mockResolvedValue(activeMapRecordId),
  };
  const cargoRepo = cargoQuery(0);
  const taskRepo = { find: jest.fn().mockResolvedValue([]) };
  const service = new OperatingAreasService(
    zones as unknown as ZoneService,
    {} as KernelApiService,
    cargoRepo as never,
    taskRepo as never,
    { namesOf: jest.fn().mockResolvedValue(new Map()) } as never,
    { removeManyOnMap: jest.fn() } as never,
  );
  return { service, zones };
}

const FORBIDDEN =
  'Vai trò của bạn không được gán quyền thao tác trên bản đồ đang tải.';

describe('OperatingAreasService AUTH-3 map scope', () => {
  it('rejects an Area from another map before updating or deleting it', async () => {
    const { service, zones } = makeService('map-a');
    await expect(
      service.update('zone-b', { color: '#ff0000' }, ['map-a']),
    ).rejects.toThrow();
    await expect(service.remove('zone-b', ['map-a'])).rejects.toThrow();
    expect(zones.update).not.toHaveBeenCalled();
    expect(zones.remove).not.toHaveBeenCalled();
  });
  describe('list', () => {
    it("returns [] (not a throw) when the active map falls outside the caller's scope", async () => {
      const { service } = makeService('map-a');
      await expect(service.list(['map-b'])).resolves.toEqual([]);
    });

    it('returns [] when no map is active at all and the caller is scoped', async () => {
      const { service } = makeService(null);
      await expect(service.list(['map-b'])).resolves.toEqual([]);
    });

    it('proceeds normally when the active map is within scope', async () => {
      const { service, zones } = makeService('map-a');
      await service.list(['map-a', 'map-b']);
      expect(zones.list).toHaveBeenCalled();
    });

    it('is unaffected when mapIds is undefined (unrestricted — regression guard)', async () => {
      const { service, zones } = makeService(null);
      await service.list(undefined);
      expect(zones.list).toHaveBeenCalled();
    });
  });

  describe('mutating methods throw Forbidden when the active map is out of scope', () => {
    it('create', async () => {
      const { service } = makeService('map-a');
      await expect(
        service.create({ name: 'Kho A', kind: 'ZONE', members: [] }, ['map-b']),
      ).rejects.toThrow(FORBIDDEN);
    });

    it('update', async () => {
      const { service } = makeService('map-a');
      await expect(service.update('zone-1', {}, ['map-b'])).rejects.toThrow(
        FORBIDDEN,
      );
    });

    it('remove', async () => {
      const { service } = makeService('map-a');
      await expect(service.remove('zone-1', ['map-b'])).rejects.toThrow(
        FORBIDDEN,
      );
    });

    it('sync', async () => {
      const { service } = makeService('map-a');
      await expect(service.sync(['map-b'])).rejects.toThrow(FORBIDDEN);
    });

    it('replaceMembers', async () => {
      const { service } = makeService('map-a');
      await expect(
        service.replaceMembers('zone-1', { members: [] }, ['map-b']),
      ).rejects.toThrow(FORBIDDEN);
    });
  });

  describe('mutating methods proceed when the active map is in scope, or the caller is unrestricted', () => {
    it('sync — in scope', async () => {
      const { service, zones } = makeService('map-a');
      await service.sync(['map-a']);
      expect(zones.sync).toHaveBeenCalled();
    });

    it('sync — unrestricted (mapIds undefined)', async () => {
      const { service, zones } = makeService('map-a');
      await service.sync(undefined);
      expect(zones.sync).toHaveBeenCalled();
    });
  });
});

describe('OperatingAreasService.update — name and color', () => {
  const zoneFixture = {
    id: 'zone-1',
    name: 'Old name',
    type: 'PICKUP',
    color: '#111111',
    plantModelName: 'factory-a',
    status: 'ACTIVE',
    members: [],
  };

  function makeUpdateService() {
    const zones = {
      list: jest.fn().mockResolvedValue([zoneFixture]),
      create: jest.fn().mockResolvedValue({ id: 'zone-1' }),
      update: jest.fn().mockResolvedValue(undefined),
      activeMapRecordId: jest.fn().mockResolvedValue('map-a'),
    };
    const cargoRepo = {
      ...cargoQuery(0),
      find: jest.fn().mockResolvedValue([]),
    };
    const taskRepo = { find: jest.fn().mockResolvedValue([]) };
    const service = new OperatingAreasService(
      zones as unknown as ZoneService,
      { loadOperation: 'load', unloadOperation: 'unload' } as KernelApiService,
      cargoRepo as never,
      taskRepo as never,
      { namesOf: jest.fn().mockResolvedValue(new Map()) } as never,
      { removeManyOnMap: jest.fn() } as never,
    );
    return { service, zones };
  }

  it('passes name through to ZoneService.update when provided', async () => {
    const { service, zones } = makeUpdateService();
    await service.update('zone-1', { name: 'Kho mới' });
    expect(zones.update).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({ name: 'Kho mới' }),
      undefined,
    );
  });

  it('trims a whitespace-padded name before passing it through', async () => {
    const { service, zones } = makeUpdateService();
    await service.update('zone-1', { name: '  Kho mới  ' });
    expect(zones.update).toHaveBeenCalledWith(
      'zone-1',
      expect.objectContaining({ name: 'Kho mới' }),
      undefined,
    );
  });

  it('does not call ZoneService.update at all when neither name nor a valid color is given', async () => {
    const { service, zones } = makeUpdateService();
    await service.update('zone-1', {});
    expect(zones.update).not.toHaveBeenCalled();
  });

  it('still updates color alone, unaffected by the name addition', async () => {
    const { service, zones } = makeUpdateService();
    await service.update('zone-1', { color: '#abcdef' });
    expect(zones.update).toHaveBeenCalledWith(
      'zone-1',
      { color: '#abcdef' },
      undefined,
    );
  });

  it('passes operation through to ZoneService.update when provided', async () => {
    const { service, zones } = makeUpdateService();
    await service.update('zone-1', { operation: 'Charge' });
    expect(zones.update).toHaveBeenCalledWith(
      'zone-1',
      { operation: 'Charge' },
      undefined,
    );
  });

  it('passes maxVehicles through, including an explicit null to clear it', async () => {
    const { service, zones } = makeUpdateService();
    await service.update('zone-1', { maxVehicles: null });
    expect(zones.update).toHaveBeenCalledWith(
      'zone-1',
      { maxVehicles: null },
      undefined,
    );
  });

  it('creates an Area with operation and maxVehicles when provided', async () => {
    const { service, zones } = makeUpdateService();
    await service.create({
      name: 'Kho A',
      kind: 'ZONE',
      operation: 'Charge',
      maxVehicles: 3,
      members: [],
    });
    expect(zones.create).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'Charge', maxVehicles: 3 }),
      undefined,
    );
  });
});

interface CargoQueryMock {
  where: jest.Mock;
  andWhere: jest.Mock;
  select: jest.Mock;
  getCount: jest.Mock;
  getMany: jest.Mock;
}

function cargoQuery(count: number, rows: { id: string }[] = []) {
  const conditions: string[] = [];
  const query: CargoQueryMock = {
    where: jest.fn(() => query),
    andWhere: jest.fn((condition: string) => {
      conditions.push(condition);
      return query;
    }),
    select: jest.fn(() => query),
    getCount: jest.fn().mockResolvedValue(count),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return { createQueryBuilder: jest.fn(() => query), conditions };
}

describe('OperatingAreasService.purgeFinishedCargo', () => {
  function makePurgeService(unfinished: number, finishedIds: string[]) {
    const zones = { activeMapRecordId: jest.fn().mockResolvedValue('map-a') };
    const cargoRepo = cargoQuery(
      unfinished,
      finishedIds.map((id) => ({ id })),
    );
    const cargo = {
      removeManyOnMap: jest
        .fn()
        .mockImplementation((ids: string[]) =>
          Promise.resolve(ids.map((cargoId) => ({ cargoId, reason: null }))),
        ),
    };
    const service = new OperatingAreasService(
      zones as unknown as ZoneService,
      {} as KernelApiService,
      cargoRepo as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { namesOf: jest.fn().mockResolvedValue(new Map()) } as never,
      cargo as never,
    );
    jest
      .spyOn(service as never, 'oneArea' as never)
      .mockResolvedValue({ wesId: 'zone-1' } as never);
    return { service, cargo, cargoRepo };
  }

  it('refuses with 409 and deletes nothing while a cargo is unfinished', async () => {
    const { service, cargo } = makePurgeService(2, ['c1']);
    await expect(service.purgeFinishedCargo('zone-1')).rejects.toThrow(
      'Còn 2 hàng chưa hoàn thành',
    );
    expect(cargo.removeManyOnMap).not.toHaveBeenCalled();
  });

  it('deletes every finished cargo of the area on the loaded map', async () => {
    const { service, cargo } = makePurgeService(0, ['c1', 'c2']);
    await expect(service.purgeFinishedCargo('zone-1')).resolves.toEqual({
      deleted: 2,
      failed: [],
    });
    expect(cargo.removeManyOnMap).toHaveBeenCalledWith(['c1', 'c2'], 'map-a');
  });

  it('treats cargo whose task failed or was cancelled as finished, not as unfinished', async () => {
    const { service, cargoRepo } = makePurgeService(0, ['c1']);
    await service.purgeFinishedCargo('zone-1');
    const [unfinished, finished] = cargoRepo.conditions;
    expect(unfinished).toContain("cargo.status = 'ACTIVE'");
    expect(unfinished).toContain("NOT IN ('FAILED', 'CANCELLED')");
    expect(finished).toContain("cargo.status IN ('DELIVERED', 'FAILED')");
    expect(finished).toContain(`NOT ${unfinished}`);
  });

  it('refuses a caller whose map scope excludes the loaded map', async () => {
    const { service, cargo } = makePurgeService(0, ['c1']);
    await expect(
      service.purgeFinishedCargo('zone-1', ['map-b']),
    ).rejects.toThrow('không được gán quyền');
    expect(cargo.removeManyOnMap).not.toHaveBeenCalled();
  });
});

describe('OperatingAreasService area guard — cargo holding an area', () => {
  function makeGuardedService(holding: number) {
    const zones = {
      activeMapRecordId: jest.fn().mockResolvedValue('map-a'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const cargoRepo = cargoQuery(holding);
    const service = new OperatingAreasService(
      zones as unknown as ZoneService,
      {} as KernelApiService,
      cargoRepo as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { namesOf: jest.fn().mockResolvedValue(new Map()) } as never,
      { removeManyOnMap: jest.fn() } as never,
    );
    jest
      .spyOn(service as never, 'oneArea' as never)
      .mockResolvedValue({ wesId: 'zone-1' } as never);
    return { service, zones, cargoRepo };
  }

  it('refuses to delete an area while cargo holds it', async () => {
    const { service, zones } = makeGuardedService(1);
    await expect(service.remove('zone-1')).rejects.toThrow(
      'Còn hàng đang xử lý trong khu vực này',
    );
    expect(zones.remove).not.toHaveBeenCalled();
  });

  it('deletes an area no cargo holds', async () => {
    const { service, zones } = makeGuardedService(0);
    await service.remove('zone-1');
    expect(zones.remove).toHaveBeenCalledWith('zone-1', undefined);
  });

  it('counts delivered cargo only for its drop area, never for the pickup area it left', async () => {
    const { service, cargoRepo } = makeGuardedService(0);
    await service.remove('zone-1');
    const [holds] = cargoRepo.conditions;
    const [pickupSide, dropSide] = holds.split(
      ' OR (cargo.destination_zone_id = :zoneId',
    );
    expect(pickupSide).toContain('cargo.source_zone_id = :zoneId');
    expect(pickupSide).not.toContain("'DELIVERED'");
    expect(dropSide).toContain("cargo.status = 'DELIVERED'");
  });

  it('releases the pickup area once a vehicle has taken the cargo away', async () => {
    const { service, cargoRepo } = makeGuardedService(0);
    await service.remove('zone-1');
    const [holds] = cargoRepo.conditions;
    const [pickupSide] = holds.split(
      ' OR (cargo.destination_zone_id = :zoneId',
    );
    expect(pickupSide).toContain(
      "IN ('DELIVERING', 'DELIVERY_COMPLETED', 'COMPLETED')",
    );
  });
});
