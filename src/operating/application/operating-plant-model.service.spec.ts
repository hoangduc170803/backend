import { OperatingPlantModelService } from './operating-plant-model.service';
import type { KernelApiService } from '../../opentcs/kernel-api.service';

function makeService(rawModel: unknown) {
  const kernelApi = {
    getRawPlantModel: jest.fn().mockResolvedValue(rawModel),
    chargeOperation: 'Charge',
  };
  return {
    service: new OperatingPlantModelService(kernelApi as unknown as KernelApiService),
    kernelApi,
  };
}

describe('OperatingPlantModelService.locations', () => {
  it('maps each kernel Location to its name, type and linked point names', async () => {
    const { service } = makeService({
      locations: [
        {
          name: 'location_P1',
          typeName: 'Pick up',
          links: [{ pointName: 'P1' }],
        },
        {
          name: 'location_P2',
          typeName: 'Drop off',
          links: [{ pointName: 'P2' }],
        },
      ],
    });

    await expect(service.locations()).resolves.toEqual([
      { name: 'location_P1', type: 'Pick up', pointNames: ['P1'] },
      { name: 'location_P2', type: 'Drop off', pointNames: ['P2'] },
    ]);
  });

  it('falls back to the legacy `type` field when `typeName` is absent', async () => {
    const { service } = makeService({
      locations: [{ name: 'loc-1', type: 'Charging', links: [{ pointName: 'P1' }] }],
    });

    await expect(service.locations()).resolves.toEqual([
      { name: 'loc-1', type: 'Charging', pointNames: ['P1'] },
    ]);
  });

  it('drops links with no point name and locations with no name at all', async () => {
    const { service } = makeService({
      locations: [
        { name: 'loc-1', links: [{ pointName: 'P1' }, {}] },
        { links: [{ pointName: 'P2' }] },
      ],
    });

    await expect(service.locations()).resolves.toEqual([
      { name: 'loc-1', type: '', pointNames: ['P1'] },
    ]);
  });

  it('returns an empty array when the kernel has no plant model loaded', async () => {
    const { service } = makeService(null);
    await expect(service.locations()).resolves.toEqual([]);
  });

  it('returns an empty array when the model has no locations at all', async () => {
    const { service } = makeService({});
    await expect(service.locations()).resolves.toEqual([]);
  });
});
