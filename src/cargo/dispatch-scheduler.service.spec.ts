import { kernelSessionStub } from '../kernel-session/kernel-session.testing';
import { DispatchSchedulerService } from './dispatch-scheduler.service';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const engine = (run: jest.Mock) => ({ run }) as never;
const claims = (reconcile: jest.Mock) => ({ reconcile }) as never;
const flushOf = (svc: DispatchSchedulerService) =>
  (svc as unknown as { flush(): Promise<void> }).flush();

describe('DispatchSchedulerService single-flight', () => {
  it('stays frozen while the kernel is not ready', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const reconcile = jest.fn().mockResolvedValue(undefined);
    const svc = new DispatchSchedulerService(
      engine(run),
      engine(run),
      engine(run),
      engine(run),
      engine(run),
      engine(run),
      claims(reconcile),
      engine(run),
      engine(run),
      engine(run),
      kernelSessionStub({ ready: false }),
    );

    await flushOf(svc);

    expect(run).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('never runs two flush cycles concurrently', async () => {
    const gate = deferred<void>();
    const leg = jest.fn().mockReturnValue(gate.promise); // hold flush #1 open
    const release = jest.fn().mockResolvedValue(undefined);
    const assign = jest.fn().mockResolvedValue(undefined);
    const charge = jest.fn().mockResolvedValue(undefined);
    const park = jest.fn().mockResolvedValue(undefined);
    const reconcile = jest.fn().mockResolvedValue(undefined);
    const orders = jest.fn().mockResolvedValue(undefined);
    const recall = jest.fn().mockResolvedValue(undefined);
    const svc = new DispatchSchedulerService(
      engine(leg),
      engine(jest.fn().mockResolvedValue(undefined)),
      engine(release),
      engine(assign),
      engine(charge),
      engine(park),
      claims(reconcile),
      engine(orders),
      engine(recall),
      engine(recall),
      kernelSessionStub(),
    );

    const p1 = flushOf(svc); // enters, awaits leg-reconcile (pending)
    const p2 = flushOf(svc); // sees in-flight → returns immediately
    await p2;

    // Flush #2 did not start the pipeline; flush #1 is still stuck on leg-reconcile.
    expect(leg).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    gate.resolve();
    await p1;

    // The whole pipeline ran exactly once, in order.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(leg).toHaveBeenCalledTimes(1);
    expect(orders).toHaveBeenCalledTimes(1);
    expect(leg.mock.invocationCallOrder[0]).toBeLessThan(
      orders.mock.invocationCallOrder[0],
    );
    expect(orders.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0],
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(park).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      assign.mock.invocationCallOrder[0],
    );
  });

  it('re-schedules once when a trigger arrives mid-flush (no work dropped)', async () => {
    const gate = deferred<void>();
    const leg = jest.fn().mockReturnValue(gate.promise);
    const ok = () => jest.fn().mockResolvedValue(undefined);
    const svc = new DispatchSchedulerService(
      engine(leg),
      engine(ok()),
      engine(ok()),
      engine(ok()),
      engine(ok()),
      engine(ok()),
      claims(ok()),
      engine(ok()),
      engine(ok()),
      engine(ok()),
      kernelSessionStub(),
    );
    // Stub schedule so the rerun doesn't leave a real timer pending.
    const schedule = jest
      .spyOn(svc, 'schedule')
      .mockImplementation(() => undefined);

    const p1 = flushOf(svc); // in flight
    await flushOf(svc); // mid-flush trigger → marks rerunWanted
    gate.resolve();
    await p1;

    expect(schedule).toHaveBeenCalledTimes(1); // rerun requested exactly once
  });
});

describe('DispatchSchedulerService max-wait', () => {
  const idle = () => jest.fn().mockResolvedValue(undefined);
  const build = () =>
    new DispatchSchedulerService(
      engine(idle()),
      engine(idle()),
      engine(idle()),
      engine(idle()),
      engine(idle()),
      engine(idle()),
      claims(idle()),
      engine(idle()),
      engine(idle()),
      engine(idle()),
      kernelSessionStub(),
    );
  const stubFlush = (svc: DispatchSchedulerService) =>
    jest
      .spyOn(svc as unknown as { flush: () => Promise<void> }, 'flush')
      .mockResolvedValue(undefined);

  const triggerEverySecondUntilDeadline = (svc: DispatchSchedulerService) => {
    svc.schedule();
    for (let elapsed = 1_000; elapsed <= 3_000; elapsed += 1_000) {
      jest.advanceTimersByTime(1_000);
      svc.schedule();
    }
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps the plain debounce window when triggers stop', () => {
    const svc = build();
    const flush = stubFlush(svc);

    svc.schedule();
    jest.advanceTimersByTime(1_499);
    expect(flush).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('still flushes when triggers keep arriving faster than the debounce window', () => {
    const svc = build();
    const flush = stubFlush(svc);

    triggerEverySecondUntilDeadline(svc);
    expect(flush).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh max-wait budget after the deadline flush', () => {
    const svc = build();
    const flush = stubFlush(svc);

    triggerEverySecondUntilDeadline(svc);
    jest.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);

    svc.schedule();
    jest.advanceTimersByTime(1_499);
    expect(flush).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
