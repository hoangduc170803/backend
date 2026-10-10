import { Subject } from 'rxjs';
import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import type {
  TransportOrderDto,
  VehicleRealtimeDto,
} from '../dto/operating.dto';
import {
  OperatingProjectionService,
  type StreamFrame,
} from './operating-projection.service';
import { emptySummary } from './operating-summary.service';
import type { OrderRetentionOp } from './order-retention';

function vehicleDto(
  name: string,
  extra: Partial<VehicleRealtimeDto> = {},
): VehicleRealtimeDto {
  return {
    name,
    serialNumber: null,
    x: 0,
    y: 0,
    orientationAngle: 0,
    currentPosition: 'P1',
    state: 'IDLE',
    procState: 'IDLE',
    integrationLevel: 'TO_BE_UTILIZED',
    energyLevel: 80,
    batteryVoltage: null,
    transportOrder: null,
    paused: false,
    reportedPaused: null,
    loaded: false,
    fatalErrorCodes: [],
    warningErrorCodes: [],
    errorDescriptions: {},
    routePoints: [],
    routeProgressPercent: 0,
    routeSteps: [],
    allocatedResources: [],
    ...extra,
  };
}

function order(name: string, state: string): TransportOrderDto {
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
  };
}

type State = KernelVehicleState & Partial<VehicleRealtimeDto>;

function setup(initial: State[] = []) {
  const states$ = new Subject<KernelVehicleState>();
  const retainedOps$ = new Subject<OrderRetentionOp>();
  const taskChanges$ = new Subject<void>();
  const cargoChanges$ = new Subject<void>();
  const areaChanges$ = new Subject<void>();
  const retained: TransportOrderDto[] = [];
  const enrich = jest.fn((state: State) =>
    Promise.resolve(vehicleDto(state.name, state)),
  );
  const vehicles = {
    states$,
    enrich,
    currentStates: jest.fn().mockResolvedValue(initial),
  };
  const orders = {
    retainedOps$,
    retained: () => retained,
    counts: () => ({ active: 0, processing: 0, recentTerminal: 0 }),
    resetForNewMap: jest.fn().mockImplementation(() => {
      retained.length = 0;
      return Promise.resolve();
    }),
  };
  const summaries = { compute: jest.fn().mockResolvedValue(emptySummary()) };
  const taskList: { taskId: string; status: string }[] = [];
  const cargoList: { cargoId: string; status: string }[] = [];
  const listTasks = jest.fn(() =>
    Promise.resolve({ tasks: [...taskList], total: 0, truncated: false }),
  );
  const listCargos = jest.fn(() =>
    Promise.resolve({ cargos: [...cargoList], total: 0, truncated: false }),
  );
  const service = new OperatingProjectionService(
    vehicles as never,
    orders as never,
    { changes$: taskChanges$, list: listTasks } as never,
    { changes$: cargoChanges$, list: listCargos } as never,
    { changes$: areaChanges$, list: () => Promise.resolve([]) } as never,
    summaries as never,
    {
      overlayFor: () => Promise.resolve([]),
      cargoFootprint: { lengthMm: 800, widthMm: 800 },
    } as never,
    { id: () => Promise.resolve('map-1') } as never,
  );
  service.onModuleInit();

  const listen = (cursor?: string) => {
    const frames: StreamFrame[] = [];
    const subscription = service.open(cursor).subscribe((frame) => {
      frames.push(frame);
    });
    return {
      frames,
      events: () =>
        frames.map((frame) => JSON.parse(frame.data) as Record<string, any>),
      stop: () => subscription.unsubscribe(),
    };
  };
  const pushOrder = (op: OrderRetentionOp) => {
    if (op.op === 'upsert') {
      const index = retained.findIndex((kept) => kept.name === op.order.name);
      if (index === -1) retained.push(op.order);
      else retained[index] = op.order;
    } else {
      const index = retained.findIndex((kept) => kept.name === op.name);
      if (index !== -1) retained.splice(index, 1);
    }
    retainedOps$.next(op);
  };
  return {
    service,
    states$,
    enrich,
    summaries,
    orders,
    taskChanges$,
    cargoChanges$,
    areaChanges$,
    taskList,
    cargoList,
    listTasks,
    listCargos,
    listen,
    pushOrder,
  };
}

const settle = () => jest.advanceTimersByTimeAsync(0);
const vehicle = (name: string, extra: Partial<State> = {}): State =>
  ({ name, ...extra }) as State;

describe('OperatingProjectionService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('opens a session with a consistent snapshot of the active set, then deltas', async () => {
    const ctx = setup([vehicle('V1'), vehicle('V2')]);
    await settle();
    ctx.pushOrder({ op: 'upsert', order: order('TO-1', 'BEING_PROCESSED') });

    const session = ctx.listen();
    const opening = session.events();

    expect(opening.map((frame) => `${frame.kind}:${frame.op}`)).toEqual([
      'session:snapshot-begin',
      'vehicle:snapshot',
      'order:snapshot',
      'task:snapshot',
      'cargo:snapshot',
      'area:snapshot',
      'obstacle:snapshot',
      'footprint:snapshot',
      'summary:snapshot',
      'session:snapshot-end',
    ]);
    expect(opening[1].items.map((item: { id: string }) => item.id)).toEqual([
      'V1',
      'V2',
    ]);
    expect(opening[2].items[0]).toMatchObject({ id: 'TO-1', rev: 1 });
    expect(opening[0].seq).toBe(opening.at(-1)!.seq);

    ctx.states$.next(vehicle('V1', { state: 'EXECUTING' }));
    await settle();

    const delta = session.events().at(-1)!;
    expect(delta).toMatchObject({
      kind: 'vehicle',
      op: 'patch',
      id: 'V1',
      rev: 2,
      payload: { state: 'EXECUTING' },
      seq: opening[0].seq + 1,
    });
    session.stop();
  });

  it('replays only what a reconnecting client missed', async () => {
    const ctx = setup([vehicle('V1')]);
    await settle();
    const first = ctx.listen();
    const epoch = first.events()[0].epoch as string;
    const seenSeq = first.events()[0].seq as number;
    first.stop();

    ctx.states$.next(vehicle('V1', { state: 'EXECUTING' }));
    await settle();
    ctx.pushOrder({ op: 'upsert', order: order('TO-9', 'DISPATCHABLE') });

    const resumed = ctx.listen(`${epoch}:${seenSeq}`).events();

    expect(resumed.map((frame) => `${frame.kind}:${frame.op}`)).toEqual([
      'session:resume',
      'vehicle:patch',
      'order:upsert',
    ]);
  });

  it('falls back to a fresh snapshot for a cursor of another epoch', async () => {
    const ctx = setup([vehicle('V1')]);
    await settle();

    const frames = ctx.listen('some-older-boot.0:12').events();

    expect(frames[0]).toMatchObject({ kind: 'session', op: 'snapshot-begin' });
  });

  it('gathers pose updates of one vehicle into a single patch per interval', async () => {
    const ctx = setup([vehicle('V1')]);
    await settle();
    const session = ctx.listen();
    const before = session.frames.length;

    for (let x = 1; x <= 25; x++) {
      ctx.states$.next(vehicle('V1', { x }));
      await settle();
    }
    expect(session.frames).toHaveLength(before);

    await jest.advanceTimersByTimeAsync(100);

    const patches = session.events().slice(before);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ op: 'patch', payload: { x: 25 } });
  });

  it('sends an error at once, together with the pose it was holding back', async () => {
    const ctx = setup([vehicle('V1')]);
    await settle();
    const session = ctx.listen();
    const before = session.frames.length;

    ctx.states$.next(vehicle('V1', { x: 7 }));
    await settle();
    ctx.states$.next(vehicle('V1', { x: 7, fatalErrorCodes: ['eStop'] }));
    await settle();

    const patches = session.events().slice(before);
    expect(patches).toHaveLength(1);
    expect(patches[0].payload).toEqual({ x: 7, fatalErrorCodes: ['eStop'] });

    await jest.advanceTimersByTimeAsync(200);
    expect(session.frames).toHaveLength(before + 1);
  });

  it('never lets a slower, older enrichment overwrite a newer state', async () => {
    const ctx = setup([vehicle('V1')]);
    await settle();
    const session = ctx.listen();
    const before = session.frames.length;
    let releaseOld!: () => void;
    ctx.enrich.mockImplementationOnce(
      (state: State) =>
        new Promise((resolve) => {
          releaseOld = () => resolve(vehicleDto(state.name, state));
        }),
    );

    ctx.states$.next(vehicle('V1', { state: 'EXECUTING' }));
    ctx.states$.next(vehicle('V1', { state: 'ERROR' }));
    await settle();
    releaseOld();
    await settle();

    const patches = session.events().slice(before);
    expect(patches.map((patch): unknown => patch.payload.state)).toEqual([
      'ERROR',
    ]);
  });

  it('starts a new epoch on a map load and tells open sessions to resync', async () => {
    const ctx = setup([vehicle('V1')]);
    await settle();
    const session = ctx.listen();
    const oldEpoch = session.events()[0].epoch as string;
    const oldCursor = `${oldEpoch}:${session.events()[0].seq}`;

    await ctx.service.onMapLoaded();
    await settle();

    expect(session.events()).toContainEqual({ kind: 'map', op: 'reset' });
    expect(ctx.orders.resetForNewMap).toHaveBeenCalled();
    const reopened = ctx.listen(oldCursor).events();
    expect(reopened[0]).toMatchObject({ op: 'snapshot-begin' });
    expect(reopened[0].epoch).not.toBe(oldEpoch);
  });

  it('removes an order from the active view when it leaves the retained set', async () => {
    const ctx = setup();
    await settle();
    ctx.pushOrder({ op: 'upsert', order: order('TO-1', 'FINISHED') });
    const session = ctx.listen();

    ctx.pushOrder({ op: 'remove', name: 'TO-1' });

    expect(session.events().at(-1)).toMatchObject({
      kind: 'order',
      op: 'remove',
      id: 'TO-1',
      rev: 2,
    });
    expect(ctx.service.stats().orders).toBe(0);
  });

  it('reads a list once per burst and sends only the objects that changed', async () => {
    const ctx = setup();
    ctx.cargoList.push(
      { cargoId: 'C1', status: 'QUEUED' },
      { cargoId: 'C2', status: 'QUEUED' },
    );
    await jest.advanceTimersByTimeAsync(200);
    const session = ctx.listen();
    const before = session.frames.length;
    const readsBefore = ctx.listCargos.mock.calls.length;

    ctx.cargoList[1] = { cargoId: 'C2', status: 'CARRYING' };
    ctx.cargoList.push({ cargoId: 'C3', status: 'QUEUED' });
    for (let index = 0; index < 40; index++) ctx.cargoChanges$.next();
    await jest.advanceTimersByTimeAsync(200);

    expect(ctx.listCargos.mock.calls.length).toBe(readsBefore + 1);
    expect(
      session
        .events()
        .slice(before)
        .filter((frame) => frame.kind === 'cargo')
        .map((frame) => `${frame.op}:${frame.id}:${frame.rev}`),
    ).toEqual(['upsert:C2:2', 'upsert:C3:1']);
  });

  it('removes an object that left its list and hands newcomers the list in the snapshot', async () => {
    const ctx = setup();
    ctx.taskList.push(
      { taskId: 'T1', status: 'CREATED' },
      { taskId: 'T2', status: 'CREATED' },
    );
    await jest.advanceTimersByTimeAsync(200);
    const session = ctx.listen();
    const before = session.frames.length;

    ctx.taskList.shift();
    ctx.taskChanges$.next();
    await jest.advanceTimersByTimeAsync(200);

    expect(session.events().slice(before)).toEqual([
      expect.objectContaining({ kind: 'task', op: 'remove', id: 'T1', rev: 2 }),
    ]);
    const tasks = ctx
      .listen()
      .events()
      .find((frame) => frame.kind === 'task' && frame.op === 'snapshot')!;
    expect(tasks.items).toEqual([
      { id: 'T2', rev: 1, payload: { taskId: 'T2', status: 'CREATED' } },
    ]);
  });

  it('sends nothing when a list was re-read and nothing in it changed', async () => {
    const ctx = setup();
    ctx.cargoList.push({ cargoId: 'C1', status: 'QUEUED' });
    await jest.advanceTimersByTimeAsync(200);
    const session = ctx.listen();
    const before = session.frames.length;

    ctx.cargoChanges$.next();
    await jest.advanceTimersByTimeAsync(200);

    expect(
      session
        .events()
        .slice(before)
        .filter((frame) => frame.kind === 'cargo'),
    ).toEqual([]);
  });

  it('publishes the summary only when it actually changed', async () => {
    const ctx = setup();
    await jest.advanceTimersByTimeAsync(600);
    const session = ctx.listen();
    const before = session.frames.length;

    ctx.taskChanges$.next();
    await jest.advanceTimersByTimeAsync(700);
    const afterUnchanged = session
      .events()
      .slice(before)
      .filter((frame) => frame.kind === 'summary');
    expect(afterUnchanged).toEqual([]);

    ctx.summaries.compute.mockResolvedValue({
      ...emptySummary(),
      tasks: { byStatus: { BLOCKED: 2 }, total: 2 },
    });
    ctx.taskChanges$.next();
    await jest.advanceTimersByTimeAsync(700);

    const summaries = session
      .events()
      .filter((frame) => frame.kind === 'summary' && frame.op === 'upsert');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload.tasks.total).toBe(2);
  });

  it('keeps its replay memory bounded however long it runs', async () => {
    const ctx = setup([vehicle('V1')]);
    await settle();

    for (let index = 0; index < 12_000; index++) {
      ctx.pushOrder({
        op: 'upsert',
        order: order(`TO-${index}`, 'BEING_PROCESSED'),
      });
      ctx.pushOrder({ op: 'remove', name: `TO-${index}` });
    }

    const stats = ctx.service.stats();
    expect(stats.replayEntries).toBeLessThanOrEqual(5_000);
    expect(stats.replayBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(stats.orders).toBe(0);
  });
});
