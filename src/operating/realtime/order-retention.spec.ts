import type { TransportOrderDto } from '../dto/operating.dto';
import { OrderRetention } from './order-retention';

const MINUTE = 60_000;
const LIMITS = { maxRecentTerminal: 3, recentTerminalTtlMs: 15 * MINUTE };

function order(
  name: string,
  state: string,
  extra: Partial<TransportOrderDto> = {},
): TransportOrderDto {
  return {
    name,
    type: '-',
    state,
    processingVehicle: null,
    intendedVehicle: null,
    wrappingSequence: null,
    destinations: [],
    creationTime: null,
    finishedTime: null,
    taskId: null,
    ...extra,
  };
}

describe('OrderRetention', () => {
  it('keeps every order still being executed, however many there are', () => {
    const retention = new OrderRetention(LIMITS);
    for (let index = 0; index < 500; index++) {
      retention.apply(order(`TO-${index}`, 'BEING_PROCESSED'), 0);
    }

    expect(retention.list()).toHaveLength(500);
    expect(retention.counts()).toEqual({
      active: 500,
      processing: 500,
      recentTerminal: 0,
    });
  });

  it('does not grow with the number of orders that ended', () => {
    const retention = new OrderRetention(LIMITS);
    const removed: string[] = [];
    for (let index = 0; index < 5_000; index++) {
      retention.apply(order(`TO-${index}`, 'BEING_PROCESSED'), index);
      for (const op of retention.apply(
        order(`TO-${index}`, 'FINISHED'),
        index,
      )) {
        if (op.op === 'remove') removed.push(op.name);
      }
    }

    expect(retention.list().map((kept) => kept.name)).toEqual([
      'TO-4997',
      'TO-4998',
      'TO-4999',
    ]);
    expect(removed).toHaveLength(4_997);
    expect(retention.counts().active).toBe(0);
  });

  it('drops an ended order once it is older than the window', () => {
    const retention = new OrderRetention(LIMITS);
    retention.apply(order('TO-1', 'FAILED'), 0);

    expect(retention.sweep(15 * MINUTE)).toEqual([]);
    expect(retention.sweep(15 * MINUTE + 1)).toEqual([
      { op: 'remove', name: 'TO-1' },
    ]);
    expect(retention.list()).toEqual([]);
  });

  it('reports an unchanged order as no change', () => {
    const retention = new OrderRetention(LIMITS);
    retention.apply(order('TO-1', 'BEING_PROCESSED'), 0);

    expect(retention.apply(order('TO-1', 'BEING_PROCESSED'), 1)).toEqual([]);
  });

  it('treats a withdrawn order as still in progress until the kernel ends it', () => {
    const retention = new OrderRetention(LIMITS);
    retention.apply(order('TO-1', 'WITHDRAWN'), 0);

    expect(retention.counts()).toMatchObject({ active: 1, recentTerminal: 0 });
  });

  it('removes an order the kernel no longer has', () => {
    const retention = new OrderRetention(LIMITS);
    retention.apply(order('TO-1', 'BEING_PROCESSED'), 0);

    expect(retention.remove('TO-1')).toEqual([{ op: 'remove', name: 'TO-1' }]);
    expect(retention.remove('TO-1')).toEqual([]);
  });

  describe('reconcile', () => {
    it('removes active orders the kernel dropped and adds the ones it missed', () => {
      const retention = new OrderRetention(LIMITS);
      retention.apply(order('GONE', 'BEING_PROCESSED'), 0);
      retention.apply(order('KEPT', 'BEING_PROCESSED'), 0);

      const ops = retention.reconcile(
        [order('KEPT', 'BEING_PROCESSED'), order('NEW', 'DISPATCHABLE')],
        10,
      );

      expect(ops).toEqual([
        { op: 'remove', name: 'GONE' },
        { op: 'upsert', order: order('NEW', 'DISPATCHABLE') },
      ]);
    });

    it('moves an active order the kernel now reports as ended into the recent window', () => {
      const retention = new OrderRetention(LIMITS);
      retention.apply(order('TO-1', 'BEING_PROCESSED'), 0);

      retention.reconcile([order('TO-1', 'FINISHED')], 10);

      expect(retention.counts()).toEqual({
        active: 0,
        processing: 0,
        recentTerminal: 1,
      });
    });

    it('primes only the newest ended orders that are still inside the window', () => {
      const retention = new OrderRetention(LIMITS);
      const now = 60 * MINUTE;
      const endedAt = (minutesAgo: number) =>
        new Date(now - minutesAgo * MINUTE).toISOString();

      retention.reconcile(
        [
          order('OLD', 'FINISHED', { finishedTime: endedAt(30) }),
          order('A', 'FINISHED', { finishedTime: endedAt(5) }),
          order('B', 'FINISHED', { finishedTime: endedAt(4) }),
          order('C', 'FINISHED', { finishedTime: endedAt(3) }),
          order('D', 'FINISHED', { finishedTime: endedAt(2) }),
          order('FAILED-OLD', 'FAILED', { creationTime: endedAt(40) }),
        ],
        now,
      );

      expect(
        retention
          .list()
          .map((kept) => kept.name)
          .sort(),
      ).toEqual(['B', 'C', 'D']);
    });
  });
});
