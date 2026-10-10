import { LatestWins } from './latest-wins';
import { parseCursor, cursorOf } from './projection-event';
import { ReplayLog } from './replay-log';
import { diffVehicle } from './vehicle-diff';
import type { VehicleRealtimeDto } from '../dto/operating.dto';

function filled(log: ReplayLog, from: number, to: number, size = 10): void {
  for (let seq = from; seq <= to; seq++) {
    log.append({ seq, data: 'x'.repeat(size) });
  }
}

describe('ReplayLog', () => {
  it('returns exactly the events after a cursor it still holds', () => {
    const log = new ReplayLog({ maxEntries: 100, maxBytes: 10_000 });
    filled(log, 1, 10);

    expect(log.since(7, 10)?.map((entry) => entry.seq)).toEqual([8, 9, 10]);
    expect(log.since(10, 10)).toEqual([]);
    expect(log.since(0, 10)).toHaveLength(10);
  });

  it('reports a gap once the cursor fell out of the retained window', () => {
    const log = new ReplayLog({ maxEntries: 5, maxBytes: 10_000 });
    filled(log, 1, 20);

    expect(log.size).toBe(5);
    expect(log.since(14, 20)).toBeNull();
    expect(log.since(15, 20)?.map((entry) => entry.seq)).toEqual([
      16, 17, 18, 19, 20,
    ]);
  });

  it('reports a gap for a cursor ahead of the stream', () => {
    const log = new ReplayLog({ maxEntries: 5, maxBytes: 10_000 });
    filled(log, 1, 3);

    expect(log.since(9, 3)).toBeNull();
  });

  it('stays inside its byte budget', () => {
    const log = new ReplayLog({ maxEntries: 1_000, maxBytes: 100 });
    filled(log, 1, 50, 30);

    expect(log.retainedBytes).toBeLessThanOrEqual(100);
    expect(log.size).toBe(3);
  });

  it('stays bounded over a very long run', () => {
    const log = new ReplayLog({ maxEntries: 50, maxBytes: 10_000 });
    filled(log, 1, 100_000);

    expect(log.size).toBe(50);
    expect(log.since(99_990, 100_000)).toHaveLength(10);
  });
});

describe('cursor', () => {
  it('round-trips an epoch that itself contains the separator', () => {
    expect(parseCursor(cursorOf('boot.3', 42))).toEqual({
      epoch: 'boot.3',
      seq: 42,
    });
  });

  it.each([undefined, '', 'nonsense', 'epoch:', 'epoch:-1', 'epoch:1.5'])(
    'rejects %p',
    (cursor) => {
      expect(parseCursor(cursor)).toBeNull();
    },
  );
});

describe('LatestWins', () => {
  it('lets only the newest of overlapping updates through, whatever order they finish in', () => {
    const order = new LatestWins();
    const first = order.begin('V1');
    const second = order.begin('V1');

    expect(order.settle('V1', second)).toBe(true);
    expect(order.settle('V1', first)).toBe(false);
  });

  it('forgets a key once nothing is in flight for it', () => {
    const order = new LatestWins();
    for (let index = 0; index < 1_000; index++) {
      const key = `TO-${index}`;
      order.settle(key, order.begin(key));
    }

    expect(order.trackedKeys).toBe(0);
  });
});

describe('diffVehicle', () => {
  const base: VehicleRealtimeDto = {
    name: 'V1',
    serialNumber: null,
    x: 0,
    y: 0,
    orientationAngle: 0,
    currentPosition: 'P1',
    state: 'EXECUTING',
    procState: 'PROCESSING_ORDER',
    integrationLevel: 'TO_BE_UTILIZED',
    energyLevel: 80,
    batteryVoltage: null,
    transportOrder: 'TO-1',
    paused: false,
    reportedPaused: null,
    loaded: false,
    fatalErrorCodes: [],
    warningErrorCodes: [],
    errorDescriptions: {},
    routePoints: ['P2', 'P3'],
    routeProgressPercent: 0,
    routeSteps: [],
    allocatedResources: [],
  };

  it('carries only the fields that moved, and calls a pose change telemetry', () => {
    const diff = diffVehicle(base, { ...base, x: 120, y: 5 });

    expect(diff).toEqual({
      changes: { x: 120, y: 5 },
      changed: true,
      critical: false,
    });
  });

  it('leaves an unchanged route out of the patch', () => {
    const diff = diffVehicle(base, {
      ...base,
      x: 1,
      routePoints: ['P2', 'P3'],
    });

    expect(Object.keys(diff.changes)).toEqual(['x']);
  });

  it.each([
    [{ state: 'ERROR' }],
    [{ fatalErrorCodes: ['eStop'] }],
    [{ paused: true }],
    [{ transportOrder: null }],
  ] as Partial<VehicleRealtimeDto>[][])('calls %p critical', (change) => {
    expect(diffVehicle(base, { ...base, ...change }).critical).toBe(true);
  });

  it('reports no change for an identical state', () => {
    expect(diffVehicle(base, { ...base }).changed).toBe(false);
  });
});
