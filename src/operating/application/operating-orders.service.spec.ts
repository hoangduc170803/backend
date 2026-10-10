import { OperatingOrdersService } from './operating-orders.service';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import {
  TaskOrderState,
  type TaskOrderEntity,
} from '../../cargo/entities/task-order.entity';
import { TaskOrderChangedEvent } from '../../cargo/domain/events';

function rawOrder() {
  return {
    currentDriveOrderIndex: 0,
    currentRouteStepIndex: -1,
    driveOrders: [
      {
        route: {
          steps: [
            { routeIndex: 0, destinationPoint: 'P1' },
            { routeIndex: 1, destinationPoint: 'P2' },
          ],
        },
      },
    ],
  };
}

describe('OperatingOrdersService.routeProgress', () => {
  it('coalesces concurrent cache-misses for the same order into a single kernel call', async () => {
    let resolveKernelCall!: (value: unknown) => void;
    const kernelApi = {
      getTransportOrderRaw: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveKernelCall = resolve;
        }),
      ),
    };
    const service = new OperatingOrdersService(
      kernelApi as unknown as KernelApiService,
      {} as never,
      {} as never,
    );

    const first = service.routeProgress('TO-1');
    const second = service.routeProgress('TO-1');
    const third = service.routeProgress('TO-1');
    resolveKernelCall(rawOrder());
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(kernelApi.getTransportOrderRaw).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.percent).toBe(0);
    expect(a.points).toEqual(['P1', 'P2']);
  });

  it('calls the kernel again for a different order while one is in flight', async () => {
    const kernelApi = {
      getTransportOrderRaw: jest.fn().mockResolvedValue(rawOrder()),
    };
    const service = new OperatingOrdersService(
      kernelApi as unknown as KernelApiService,
      {} as never,
      {} as never,
    );

    await Promise.all([
      service.routeProgress('TO-1'),
      service.routeProgress('TO-2'),
    ]);

    expect(kernelApi.getTransportOrderRaw).toHaveBeenCalledTimes(2);
  });

  it('serves the second call from cache without hitting the kernel again', async () => {
    const kernelApi = {
      getTransportOrderRaw: jest.fn().mockResolvedValue(rawOrder()),
    };
    const service = new OperatingOrdersService(
      kernelApi as unknown as KernelApiService,
      {} as never,
      {} as never,
    );

    await service.routeProgress('TO-1');
    await service.routeProgress('TO-1');

    expect(kernelApi.getTransportOrderRaw).toHaveBeenCalledTimes(1);
  });
});

describe('OperatingOrdersService ledger projection', () => {
  const ledgerRow = (
    orderName: string,
    state: TaskOrderState = TaskOrderState.ACTIVE,
    kernelState = 'BEING_PROCESSED',
  ): TaskOrderEntity =>
    ({
      id: `row-${orderName}`,
      taskId: 'task-1',
      seq: 1,
      leg: 'PICKUP',
      orderName,
      vehicleName: 'V1',
      destinations: [],
      state,
      kernelState,
      createdAt: new Date(),
      startedAt: new Date(),
      endedAt: state === TaskOrderState.ACTIVE ? null : new Date(),
    }) as unknown as TaskOrderEntity;

  function makeService(
    open: TaskOrderEntity[] = [],
    ended: TaskOrderEntity[] = [],
  ) {
    const ledger = { open, ended };
    const byName = new Map(
      [...open, ...ended].map((row) => [row.orderName, row]),
    );
    const kernelApi = { getTransportOrderRaw: jest.fn() };
    const taskOrders = {
      openOrdersOn: jest.fn(() =>
        Promise.resolve(ledger.open.map((row) => ({ row }))),
      ),
      recentlyEndedOn: jest.fn(() => Promise.resolve(ledger.ended)),
      findByOrderName: jest.fn((name: string) =>
        Promise.resolve(byName.get(name) ?? null),
      ),
    };
    const activeMap = { id: jest.fn().mockResolvedValue('map-1') };
    const service = new OperatingOrdersService(
      kernelApi as unknown as KernelApiService,
      taskOrders as never,
      activeMap as never,
    );
    const changed = (name: string) =>
      service.onLedgerOrderChanged(new TaskOrderChangedEvent(name));
    return {
      service,
      kernelApi,
      taskOrders,
      activeMap,
      ledger,
      byName,
      changed,
    };
  }

  it('lists what is still open plus the recently ended, from the ledger and without the kernel', async () => {
    const { service, kernelApi, taskOrders } = makeService(
      [ledgerRow('TO-1')],
      [ledgerRow('TO-2', TaskOrderState.FINISHED, 'FINISHED')],
    );

    const first = await service.list();
    await service.list();

    expect(first.map((order) => order.name).sort()).toEqual(['TO-1', 'TO-2']);
    expect(taskOrders.openOrdersOn).toHaveBeenCalledTimes(1);
    expect(taskOrders.recentlyEndedOn).toHaveBeenCalledWith(
      'map-1',
      expect.any(Date),
      100,
    );
    expect(kernelApi.getTransportOrderRaw).not.toHaveBeenCalled();
    expect(service.counts()).toEqual({
      active: 1,
      processing: 1,
      recentTerminal: 1,
    });
  });

  it('lists nothing while no known map is loaded', async () => {
    const { service, activeMap, taskOrders } = makeService([ledgerRow('TO-1')]);
    activeMap.id.mockResolvedValue(null);

    expect(await service.list()).toEqual([]);
    expect(taskOrders.openOrdersOn).not.toHaveBeenCalled();
  });

  it('emits the order as the ledger holds it when the ledger reports a change', async () => {
    const { service, kernelApi, changed } = makeService([ledgerRow('TO-1')]);
    const received: unknown[] = [];
    const sub = service.changes$.subscribe((order) => received.push(order));

    await changed('TO-1');
    sub.unsubscribe();

    expect(received).toEqual([
      expect.objectContaining({ name: 'TO-1', state: 'BEING_PROCESSED' }),
    ]);
    expect(kernelApi.getTransportOrderRaw).not.toHaveBeenCalled();
  });

  it('does not keep every order that ever finished', async () => {
    const { service, byName, changed } = makeService();
    await service.list();

    for (let index = 0; index < 1_000; index++) {
      const name = `TO-${index}`;
      byName.set(name, ledgerRow(name, TaskOrderState.FINISHED, 'FINISHED'));
      await changed(name);
    }

    expect(service.retained()).toHaveLength(100);
  });

  it('removes an order whose ledger row is gone', async () => {
    const { service, byName, changed } = makeService([ledgerRow('TO-1')]);
    await service.list();
    const removed: string[] = [];
    const sub = service.retainedOps$.subscribe((op) => {
      if (op.op === 'remove') removed.push(op.name);
    });

    byName.delete('TO-1');
    await changed('TO-1');
    sub.unsubscribe();

    expect(removed).toEqual(['TO-1']);
    expect(service.retained()).toEqual([]);
  });

  it('applies only the newest of two overlapping changes of one order', async () => {
    const { service, taskOrders, changed } = makeService();
    await service.list();
    let releaseStale!: (row: TaskOrderEntity) => void;
    taskOrders.findByOrderName
      .mockReturnValueOnce(
        new Promise<TaskOrderEntity>((resolve) => {
          releaseStale = resolve;
        }),
      )
      .mockResolvedValueOnce(
        ledgerRow('TO-1', TaskOrderState.FINISHED, 'FINISHED'),
      );

    const stale = changed('TO-1');
    await changed('TO-1');
    releaseStale(ledgerRow('TO-1'));
    await stale;

    expect(service.retained().map((order) => order.state)).toEqual([
      'FINISHED',
    ]);
  });

  it('forgets the previous map’s orders when another map is loaded', async () => {
    const { service, ledger } = makeService([ledgerRow('OLD')]);
    await service.list();
    ledger.open = [ledgerRow('NEW', TaskOrderState.ACTIVE, 'DISPATCHABLE')];

    await service.resetForNewMap();

    expect(service.retained().map((order) => order.name)).toEqual(['NEW']);
  });
});
