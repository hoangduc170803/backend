import {
  TaskOrderState,
  type TaskOrderEntity,
} from './entities/task-order.entity';
import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';
import { FMS_EVENTS } from './domain/events';
import {
  KernelOrderReplayService,
  KernelUnreachableDuringReplay,
} from './kernel-order-replay.service';
import { kernelSessionStub } from '../kernel-session/kernel-session.testing';

const UNLOAD = 'Unload cargo';

function task(
  overrides: Partial<TransportTaskEntity> = {},
): TransportTaskEntity {
  return {
    id: 'task-1',
    requestCode: 'TR-1',
    kind: TaskKind.CARGO,
    status: TaskStatus.PICKING_UP,
    mapRecordId: 'map-a',
    metadata: { assignedVehicleName: 'V1' },
    ...overrides,
  } as TransportTaskEntity;
}

function row(overrides: Partial<TaskOrderEntity> = {}): TaskOrderEntity {
  return {
    id: 'row-1',
    taskId: 'task-1',
    seq: 1,
    leg: 'PICKUP',
    orderName: 'PICKUP-V1-L1-uuid',
    vehicleName: 'V1',
    destinations: [{ locationName: 'L1', operation: 'Load cargo' }],
    state: TaskOrderState.ACTIVE,
    ...overrides,
  } as TaskOrderEntity;
}

function setup(options: {
  tasks: TransportTaskEntity[];
  rows: TaskOrderEntity[];
  kernelOrders?: Record<string, string>;
  loaded?: Record<string, boolean>;
}) {
  const reachable = { value: true };
  const replayed: { orderName: string; destinations: unknown }[] = [];
  const pending: string[] = [];
  const emitted: string[] = [];
  const failReplay = { value: false };
  const kernelOrders = options.kernelOrders ?? {};
  const service = new KernelOrderReplayService(
    { find: () => Promise.resolve(options.tasks) } as never,
    { ordersOf: () => Promise.resolve(options.rows) } as never,
    {
      loadOperation: 'Load cargo',
      unloadOperation: UNLOAD,
      getTransportOrderStateStrict: (name: string) =>
        Promise.resolve(kernelOrders[name] ?? null),
      isReachable: () => Promise.resolve(reachable.value),
    } as never,
    {
      replayLost: (r: TaskOrderEntity, _t: unknown, destinations: unknown) => {
        if (failReplay.value) return Promise.reject(new Error('rejected'));
        replayed.push({ orderName: r.orderName, destinations });
        return Promise.resolve(`${r.orderName}-replayed`);
      },
    } as never,
    {
      issuePending: (t: TransportTaskEntity) => {
        pending.push(t.id);
        return Promise.resolve('pending-order');
      },
    } as never,
    kernelSessionStub(),
    {
      emit: (event: string) => emitted.push(event),
      emitAsync: (event: string) => {
        emitted.push(event);
        return Promise.resolve([]);
      },
    } as never,
    {
      get: (name: string) =>
        options.loaded && name in options.loaded
          ? { loaded: options.loaded[name] }
          : undefined,
    } as never,
  );
  const run = () => service.run({ mapRecordId: 'map-a', reason: 'test' });
  return { service, run, replayed, pending, emitted, reachable, failReplay };
}

describe('KernelOrderReplayService', () => {
  it('registers itself as the last restore step', () => {
    const session = kernelSessionStub();
    const service = new KernelOrderReplayService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      session,
      {} as never,
      {} as never,
    );
    service.onModuleInit();
    expect(session.stub.steps).toEqual([service]);
    expect(service.order).toBeGreaterThan(30);
  });

  it('replays an order the kernel lost, same vehicle and destinations', async () => {
    const { run, replayed } = setup({ tasks: [task()], rows: [row()] });

    await run();

    expect(replayed).toEqual([
      {
        orderName: 'PICKUP-V1-L1-uuid',
        destinations: [{ locationName: 'L1', operation: 'Load cargo' }],
      },
    ]);
  });

  it('leaves an order the kernel still has alone', async () => {
    const { run, replayed } = setup({
      tasks: [task()],
      rows: [row()],
      kernelOrders: { 'PICKUP-V1-L1-uuid': 'BEING_PROCESSED' },
    });

    await run();

    expect(replayed).toEqual([]);
  });

  it('replays PARK and CHARGE to their old destination too', async () => {
    const { run, replayed } = setup({
      tasks: [task({ kind: TaskKind.PARK, status: TaskStatus.EXECUTING })],
      rows: [
        row({
          leg: 'PARK',
          orderName: 'PARK-V1-2000-uuid',
          destinations: [{ locationName: '2000', operation: 'MOVE' }],
        }),
      ],
    });

    await run();

    expect(replayed[0].destinations).toEqual([
      { locationName: '2000', operation: 'MOVE' },
    ]);
  });

  it('closes a drop-off leg with nothing left after the recorded unload', async () => {
    const { run, replayed, emitted } = setup({
      tasks: [
        task({
          status: TaskStatus.DELIVERING,
          metadata: { assignedVehicleName: 'V1', unloadedAt: 'x' },
        }),
      ],
      rows: [
        row({
          leg: 'DROPOFF',
          orderName: 'DROPOFF-V1-SLOT-uuid',
          destinations: [{ locationName: 'SLOT', operation: UNLOAD }],
        }),
      ],
    });

    await run();

    expect(replayed).toEqual([]);
    expect(emitted).toEqual([
      FMS_EVENTS.TASK_ORDER_STATE_CHANGED,
      FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
    ]);
  });

  it('issues the order of a task queued while the kernel was down', async () => {
    const { run, pending } = setup({
      tasks: [
        task({
          kind: TaskKind.MANUAL,
          status: TaskStatus.CREATED,
          metadata: {
            pendingOrder: {
              kind: 'MANUAL',
              vehicleName: null,
              aimedAt: 'L1',
              destinations: [{ locationName: 'L1', operation: 'MOVE' }],
            },
          },
        }),
      ],
      rows: [],
    });

    await run();

    expect(pending).toEqual(['task-1']);
  });

  it('skips finished tasks', async () => {
    const { run, replayed } = setup({
      tasks: [task({ status: TaskStatus.DELIVERY_COMPLETED })],
      rows: [row()],
    });

    await run();

    expect(replayed).toEqual([]);
  });

  it('asks for a retry of the whole restore when the kernel goes away mid-replay', async () => {
    const { run, reachable, failReplay } = setup({
      tasks: [task()],
      rows: [row()],
    });
    failReplay.value = true;
    reachable.value = false;

    await expect(run()).rejects.toBeInstanceOf(KernelUnreachableDuringReplay);
  });

  it('does not block the restore on one task the kernel rejects', async () => {
    const { run, failReplay } = setup({ tasks: [task()], rows: [row()] });
    failReplay.value = true;

    await expect(run()).resolves.toBeUndefined();
  });
  it('resumes a multi-point order from the point it was driving to', async () => {
    const { run, replayed } = setup({
      tasks: [task({ metadata: { assignedVehicleName: 'V1' } })],
      rows: [
        row({
          leg: 'MANUAL',
          orderName: 'MANUAL-V1-C-uuid',
          finishedDestinations: 1,
          destinations: [
            { locationName: 'A', operation: 'MOVE' },
            { locationName: 'B', operation: 'MOVE' },
            { locationName: 'C', operation: 'MOVE' },
          ],
        }),
      ],
    });

    await run();

    expect(replayed).toEqual([
      {
        orderName: 'MANUAL-V1-C-uuid',
        destinations: [
          { locationName: 'B', operation: 'MOVE' },
          { locationName: 'C', operation: 'MOVE' },
        ],
      },
    ]);
  });

  it('does not send a vehicle that already carries the load to lift it again', async () => {
    const { run, replayed, emitted } = setup({
      tasks: [task({ metadata: { assignedVehicleName: 'V1' } })],
      rows: [row()],
      loaded: { V1: true },
    });

    await run();

    expect(replayed).toEqual([]);
    expect(emitted).toEqual([
      FMS_EVENTS.TASK_ORDER_STATE_CHANGED,
      FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
    ]);
  });

  it('still drives to the pick-up when the vehicle reports it is empty', async () => {
    const { run, replayed } = setup({
      tasks: [task({ metadata: { assignedVehicleName: 'V1' } })],
      rows: [row()],
      loaded: { V1: false },
    });

    await run();

    expect(replayed).toHaveLength(1);
  });
  it('neither replays nor closes an order that was recorded without destinations', async () => {
    const { run, replayed, emitted } = setup({
      tasks: [task({ metadata: { assignedVehicleName: 'V1' } })],
      rows: [row({ destinations: [] })],
      loaded: { V1: true },
    });

    await run();

    expect(replayed).toEqual([]);
    expect(emitted).toEqual([]);
  });
});
