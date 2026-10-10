import { parseOpenTcsXml } from '../../opentcs/map-loader/opentcs-xml.parser';
import { ActiveMapRecordService } from './active-map-record.service';
import { MapRecordEntity } from './entities/map-record.entity';
import { KernelApiService } from '../../opentcs/kernel-api.service';

function setup(
  mostRecentlyLoaded: Partial<MapRecordEntity> | null,
  currentName: string | null,
) {
  const xml = `<model name="${mostRecentlyLoaded?.name ?? 'unknown'}"><point name="P1" positionX="1" positionY="2" positionZ="0" type="HALT_POSITION"/><visualLayout name="layout" scaleX="1" scaleY="1"/></model>`;
  if (mostRecentlyLoaded) mostRecentlyLoaded.xmlContent = xml;
  const builder = {
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(mostRecentlyLoaded),
  };
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(builder) };
  const kernelApi = {
    invalidatePlantModelCache: jest.fn(),
    getRawPlantModel: jest
      .fn()
      .mockResolvedValue(
        currentName ? { ...parseOpenTcsXml(xml), name: currentName } : null,
      ),
  };
  const svc = new ActiveMapRecordService(
    repo as never,
    kernelApi as unknown as KernelApiService,
  );
  return { svc, builder, repo, kernelApi };
}

describe('ActiveMapRecordService', () => {
  it('rejects a same-named external model with different coordinates', async () => {
    const { svc, kernelApi } = setup(
      { id: 'a', name: 'factory', lastLoadedAt: new Date() },
      'factory',
    );
    const live = await kernelApi.getRawPlantModel();
    live.points[0].position.x += 1;
    expect(await svc.resolveId()).toBeNull();
  });

  it('keeps identity after WES adds locations or live vehicle state changes', async () => {
    const { svc, kernelApi } = setup(
      { id: 'a', name: 'factory', lastLoadedAt: new Date() },
      'factory',
    );
    const live = await kernelApi.getRawPlantModel();
    live.locations.push({ name: 'location_P1', links: [{ pointName: 'P1' }] });
    live.vehicles = [{ name: 'V1', state: 'EXECUTING' }];
    expect(await svc.resolveId()).toBe('a');
  });
  it('confirms the most-recently-loaded record when its topology matches the live kernel', async () => {
    const { svc } = setup(
      { id: 'rec-1', name: 'v7-being', lastLoadedAt: new Date() },
      'v7-being',
    );
    expect(await svc.resolveId()).toBe('rec-1');
  });

  it('orders by last_loaded_at DESC NULLS LAST, not by name', async () => {
    const { svc, builder } = setup(null, null);
    await svc.resolveId();
    expect(builder.orderBy).toHaveBeenCalledWith(
      'record.last_loaded_at',
      'DESC',
      'NULLS LAST',
    );
  });

  it('returns null (external/unknown) when the kernel name does not match the last-loaded record — kernel changed from outside WES', async () => {
    const { svc } = setup(
      { id: 'rec-1', name: 'v7-being', lastLoadedAt: new Date() },
      'some-other-map',
    );
    expect(await svc.resolveId()).toBeNull();
  });

  it('returns null when nothing has ever been loaded', async () => {
    const { svc } = setup(
      { id: 'rec-1', name: 'v7-being', lastLoadedAt: null },
      'v7-being',
    );
    expect(await svc.resolveId()).toBeNull();
  });

  it('keeps the last map WES loaded while the kernel cannot be reached', async () => {
    const { svc } = setup(
      { id: 'rec-1', name: 'v7-being', lastLoadedAt: new Date() },
      null,
    );
    expect(await svc.resolveId()).toBe('rec-1');
  });

  it('still knows no map when nothing was ever loaded and the kernel cannot be reached', async () => {
    const { svc } = setup({ id: 'rec-1', name: 'v7-being' }, null);
    expect(await svc.resolveId()).toBeNull();
  });

  it('does not get confused by duplicate-named, never-loaded records — the real "v7-vda5050" case', async () => {
    // The most-recently-loaded record globally is some third, differently-named map; none of the
    // three "v7-vda5050" uploads have ever been loaded, so the kernel currently reporting
    // "v7-vda5050" must resolve to nothing rather than guessing one of the three.
    const { svc } = setup(
      { id: 'other', name: 'MapTestRCS', lastLoadedAt: new Date() },
      'v7-vda5050',
    );
    expect(await svc.resolveId()).toBeNull();
  });
});
