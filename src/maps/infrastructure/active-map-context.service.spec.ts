import { ActiveMapContext } from './active-map-context.service';
import { FmsMapLoadedEvent } from '../../cargo/domain/events';
import type { ActiveMapRecordService } from './active-map-record.service';

function setup(resolved: Array<string | null>) {
  const resolveId = jest.fn();
  for (const id of resolved) resolveId.mockResolvedValueOnce(id);
  const context = new ActiveMapContext({
    resolveId,
  } as unknown as ActiveMapRecordService);
  return { context, resolveId };
}

describe('ActiveMapContext', () => {
  afterEach(() => jest.useRealTimers());

  it('resolves once and serves the cached id within the TTL', async () => {
    const { context, resolveId } = setup(['map-a']);

    await expect(context.id()).resolves.toBe('map-a');
    await expect(context.id()).resolves.toBe('map-a');

    expect(resolveId).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first reads into one resolve', async () => {
    const { context, resolveId } = setup(['map-a']);

    await Promise.all([context.id(), context.id(), context.id()]);

    expect(resolveId).toHaveBeenCalledTimes(1);
  });

  it('switches immediately on a WES map load without resolving again', async () => {
    const { context, resolveId } = setup(['map-a']);
    await context.id();

    context.onMapLoaded(new FmsMapLoadedEvent('map-b'));

    await expect(context.id()).resolves.toBe('map-b');
    expect(resolveId).toHaveBeenCalledTimes(1);
  });

  it('re-verifies after the TTL so a map loaded outside WES is noticed', async () => {
    jest.useFakeTimers({ now: 0 });
    const { context, resolveId } = setup(['map-a', 'map-b']);
    await context.id();

    jest.setSystemTime(31_000);

    await expect(context.id()).resolves.toBe('map-b');
    expect(resolveId).toHaveBeenCalledTimes(2);
  });

  it('retries sooner while the map is unknown, and fails closed on errors', async () => {
    jest.useFakeTimers({ now: 0 });
    const { context, resolveId } = setup([null]);
    resolveId.mockRejectedValueOnce(new Error('kernel down'));
    resolveId.mockResolvedValueOnce('map-a');

    await expect(context.id()).resolves.toBeNull();
    jest.setSystemTime(6_000);
    await expect(context.id()).resolves.toBeNull();
    jest.setSystemTime(12_000);
    await expect(context.id()).resolves.toBe('map-a');
  });
});
