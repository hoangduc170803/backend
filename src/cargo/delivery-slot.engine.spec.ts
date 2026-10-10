import { DeliverySlotEngine } from './delivery-slot.engine';

const ZONE = {
  id: 'zone-1',
  name: 'khu a',
  members: [{ locationName: 'location_S1' }],
} as never;

function plantModel() {
  return {
    points: [
      { name: 'S1', position: { x: 1000, y: -1000 } },
      { name: 'A1', position: { x: 0, y: -1000 } },
    ],
    paths: [
      {
        srcPointName: 'S1',
        destPointName: 'A1',
        maxVelocity: 1,
        maxReverseVelocity: 0,
      },
    ],
    locations: [{ name: 'location_S1', links: [{ pointName: 'S1' }] }],
  };
}

function makeEngine() {
  const kernelApi = {
    getPlantModelView: jest
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(plantModel()), 5)),
      ),
  };
  return { engine: new DeliverySlotEngine(kernelApi as never), kernelApi };
}

describe('DeliverySlotEngine plant-model fetching', () => {
  it('collapses a burst of concurrent callers into one fetch', async () => {
    const { engine, kernelApi } = makeEngine();

    await Promise.all(Array.from({ length: 80 }, () => engine.layoutFor(ZONE)));

    expect(kernelApi.getPlantModelView).toHaveBeenCalledTimes(1);
  });

  it('serves later callers from the cache without touching the kernel again', async () => {
    const { engine, kernelApi } = makeEngine();

    await engine.layoutFor(ZONE);
    await engine.layoutFor(ZONE);

    expect(kernelApi.getPlantModelView).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous layout when the kernel cannot answer', async () => {
    const { engine, kernelApi } = makeEngine();

    const first = await engine.layoutFor(ZONE);
    kernelApi.getPlantModelView.mockResolvedValue(null);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const afterOutage = await engine.layoutFor(ZONE);

    expect(afterOutage).toEqual(first);
    jest.restoreAllMocks();
  });
});
