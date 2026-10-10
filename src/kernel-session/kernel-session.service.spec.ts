import {
  FmsPlantModelReplacedEvent,
  KERNEL_SESSION_EVENTS,
} from '../cargo/domain/events';
import { KernelSessionPhase } from './domain/kernel-session';
import { EPOCH_PROPERTY } from './domain/kernel-epoch';
import {
  KernelSessionLock,
  KernelSessionService,
} from './kernel-session.service';

class FakeKernel {
  reachable = true;
  operating = true;
  entities: {
    name: string;
    retired: boolean;
    properties: Record<string, string>;
  }[] = [];

  isReachable = () => Promise.resolve(this.reachable);

  listEnvironmentalEntities = () =>
    this.operating
      ? Promise.resolve(this.entities.map((entity) => ({ ...entity })))
      : Promise.reject(new Error('503'));

  createEnvironmentalEntity = (name: string, body: Record<string, unknown>) => {
    this.entities.push({
      name,
      retired: false,
      properties: body.properties as Record<string, string>,
    });
    return Promise.resolve(body);
  };

  retireEnvironmentalEntity = (name: string) => {
    const entity = this.entities.find((candidate) => candidate.name === name);
    if (entity) entity.retired = true;
    return Promise.resolve('RETIRED' as const);
  };

  reset(): void {
    this.entities = [];
  }

  epoch(): string | null {
    return (
      this.entities.find((entity) => !entity.retired)?.properties[
        EPOCH_PROPERTY
      ] ?? null
    );
  }
}

class Lock extends KernelSessionLock {
  busy = false;
  run(work: () => Promise<void>): Promise<boolean> {
    if (this.busy) return Promise.resolve(false);
    return work().then(() => true);
  }
}

function setup(mapRecordId: string | null = 'map-a') {
  const kernel = new FakeKernel();
  const lock = new Lock();
  const emitted: string[] = [];
  const ran: string[] = [];
  const session = new KernelSessionService(
    kernel as never,
    { resolveId: () => Promise.resolve(mapRecordId) } as never,
    lock,
    { emit: (event: string) => emitted.push(event) } as never,
  );
  const failing = { next: 0 };
  session.registerStep({
    name: 'orders',
    order: 40,
    run: () => {
      ran.push('orders');
      if (failing.next > 0) {
        failing.next--;
        return Promise.reject(new Error('kernel busy'));
      }
      return Promise.resolve();
    },
  });
  session.registerStep({
    name: 'vehicles',
    order: 20,
    run: () => {
      ran.push('vehicles');
      return Promise.resolve();
    },
  });
  return { kernel, lock, session, emitted, ran, failing };
}

describe('KernelSessionService', () => {
  it('starts offline and stays there while the kernel is down', async () => {
    const { kernel, session, ran } = setup();
    kernel.reachable = false;

    await session.poll();

    expect(session.snapshot().phase).toBe(KernelSessionPhase.OFFLINE);
    expect(session.isReady()).toBe(false);
    expect(ran).toEqual([]);
  });

  it('restores a kernel without an epoch: steps in order, then a new epoch and READY', async () => {
    const { kernel, session, emitted, ran } = setup();

    await session.poll();

    expect(ran).toEqual(['vehicles', 'orders']);
    expect(session.isReady()).toBe(true);
    expect(kernel.epoch()).toBe(session.snapshot().epoch);
    expect(emitted).toContain(KERNEL_SESSION_EVENTS.READY);
  });

  it('adopts a live epoch without replaying anything', async () => {
    const { kernel, session, ran } = setup();
    await session.poll();
    ran.length = 0;

    await session.poll();

    expect(ran).toEqual([]);
    expect(session.isReady()).toBe(true);
    expect(kernel.entities.filter((entity) => !entity.retired)).toHaveLength(1);
  });

  it('restores again after the kernel restarted', async () => {
    const { kernel, session, ran } = setup();
    await session.poll();
    const firstEpoch = session.snapshot().epoch;
    kernel.reachable = false;
    await session.poll();
    expect(session.snapshot().phase).toBe(KernelSessionPhase.OFFLINE);

    kernel.reachable = true;
    kernel.reset();
    ran.length = 0;
    await session.poll();

    expect(ran).toEqual(['vehicles', 'orders']);
    expect(session.snapshot().epoch).not.toBe(firstEpoch);
    expect(session.snapshot().reason).toBeNull();
  });

  it('stays RESTORING with the error and retries on the next poll', async () => {
    const { session, failing } = setup();
    failing.next = 1;

    await session.poll();
    expect(session.snapshot().phase).toBe(KernelSessionPhase.RESTORING);
    expect(session.snapshot().lastError).toContain('kernel busy');

    await session.poll();
    expect(session.isReady()).toBe(true);
    expect(session.snapshot().lastError).toBeNull();
  });

  it('holds off while a plant model write is in flight, then restores once it lands', async () => {
    const { session, ran } = setup();
    await session.poll();
    ran.length = 0;

    await session.onPlantModelReplacing(
      new FmsPlantModelReplacedEvent('zone edit'),
    );
    await session.poll();
    expect(session.snapshot().phase).toBe(KernelSessionPhase.RESTORING);
    expect(ran).toEqual([]);

    await session.onPlantModelReplaced(
      new FmsPlantModelReplacedEvent('zone edit'),
    );
    await session.poll();
    expect(ran).toEqual(['vehicles', 'orders']);
    expect(session.isReady()).toBe(true);
  });

  it('does not restore onto a map WES does not recognise', async () => {
    const { session, ran } = setup(null);

    await session.poll();

    expect(ran).toEqual([]);
    expect(session.snapshot().phase).toBe(KernelSessionPhase.RESTORING);
    expect(session.snapshot().lastError).toContain('bản đồ');
  });

  it('leaves the restore to another WES process holding the lock', async () => {
    const { lock, session, ran } = setup();
    lock.busy = true;

    await session.poll();

    expect(ran).toEqual([]);
    expect(session.isReady()).toBe(false);
  });

  it('confirms the kernel is intact only while the epoch is still there', async () => {
    const { kernel, session } = setup();
    await session.poll();
    await expect(session.confirmIntact()).resolves.toBe(true);

    kernel.reset();
    await expect(session.confirmIntact()).resolves.toBe(false);
  });
});
