import { KernelApiService } from './kernel-api.service';

const mockGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]): unknown => mockGet(...args) },
}));

function deferredModel() {
  let release!: (model: unknown) => void;
  const reply = new Promise<{ data: unknown }>((resolve) => {
    release = (model) => resolve({ data: model });
  });
  return { reply, release };
}

const model = (name: string) => ({
  name,
  points: [{ name: 'P1', type: 'HALT_POSITION', properties: [] }],
  paths: [],
  locations: [],
  locationTypes: [],
});

describe('KernelApiService plant model cache', () => {
  beforeEach(() => mockGet.mockReset());

  it('shares one kernel read between everyone asking while it is still under way', async () => {
    const pending = deferredModel();
    mockGet.mockReturnValueOnce(pending.reply);
    const svc = new KernelApiService();

    const readers = Array.from({ length: 40 }, () => svc.getRawPlantModel());
    const views = Array.from({ length: 40 }, () => svc.getPlantModelView());
    pending.release(model('first'));
    const raws = await Promise.all(readers);
    const built = await Promise.all(views);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(new Set(raws).size).toBe(1);
    expect(new Set(built).size).toBe(1);
    await svc.getRawPlantModel();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('reads again after an invalidation and never caches the read it overtook', async () => {
    const stale = deferredModel();
    const fresh = deferredModel();
    mockGet.mockReturnValueOnce(stale.reply).mockReturnValueOnce(fresh.reply);
    const svc = new KernelApiService();

    const beforeInvalidation = svc.getRawPlantModel();
    svc.invalidatePlantModelCache();
    const afterInvalidation = svc.getRawPlantModel();
    fresh.release(model('fresh'));
    stale.release(model('stale'));

    expect(await beforeInvalidation).toMatchObject({ name: 'stale' });
    expect(await afterInvalidation).toMatchObject({ name: 'fresh' });
    expect(await svc.getPlantModelName()).toBe('fresh');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('tries the kernel again after a failed read', async () => {
    mockGet.mockRejectedValueOnce(new Error('kernel down'));
    mockGet.mockResolvedValueOnce({ data: model('back') });
    const svc = new KernelApiService();

    expect(await svc.getRawPlantModel()).toBeNull();
    expect(await svc.getPlantModelName()).toBe('back');
  });
});
