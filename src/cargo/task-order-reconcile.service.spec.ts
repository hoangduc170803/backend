import { kernelSessionStub } from '../kernel-session/kernel-session.testing';
import { TaskOrderReconcileService } from './task-order-reconcile.service';
import { TaskOrderState } from './entities/task-order.entity';
import { FMS_EVENTS } from './domain/events';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

const OLD = new Date(Date.now() - 60_000);

function setup(options: {
  replacingOrderName?: string;
  row?: Record<string, unknown>;
  kernelState?: string | null | Error;
  connected?: boolean;
  driving?: string;
  kernelIntact?: boolean;
}) {
  const row = {
    taskId: 'task-1',
    orderName: 'PARK-1',
    leg: 'PARK',
    vehicleName: 'V1',
    state: TaskOrderState.ACTIVE,
    endReason: null,
    replacedBy: null,
    createdAt: OLD,
    ...options.row,
  };
  const taskOrders = {
    openOrdersOn: jest.fn().mockResolvedValue([
      {
        row,
        requestCode: 'PK-1',
        replacingOrderName: options.replacingOrderName ?? null,
      },
    ]),
    onWithdrawn: jest.fn().mockResolvedValue(undefined),
    onWithdrawRefused: jest.fn().mockResolvedValue(undefined),
  };
  const kernelState = options.kernelState;
  const kernelApi = {
    getTransportOrderStateStrict:
      kernelState instanceof Error
        ? jest.fn().mockRejectedValue(kernelState)
        : jest.fn().mockResolvedValue(kernelState),
  };
  const vehicleStore = {
    isConnected: jest.fn().mockReturnValue(options.connected ?? true),
    get: jest.fn().mockReturnValue({ transportOrder: options.driving ?? null }),
  };
  const events = { emitAsync: jest.fn().mockResolvedValue([]) };
  const service = new TaskOrderReconcileService(
    taskOrders as never,
    kernelApi as never,
    vehicleStore as never,
    fixedActiveMap(),
    events as never,
    kernelSessionStub({ intact: options.kernelIntact ?? true }),
  );
  return { service, taskOrders, kernelApi, events };
}

const replayed = (orderState: string): unknown =>
  expect.objectContaining({
    orderName: 'PARK-1',
    taskId: 'task-1',
    leg: 'PARK',
    orderState,
    processingVehicle: 'V1',
  });

describe('TaskOrderReconcileService', () => {
  it('closes a task whose order the kernel no longer knows', async () => {
    const { service, events } = setup({ kernelState: null });

    await service.run();

    expect(events.emitAsync).toHaveBeenCalledWith(
      FMS_EVENTS.TASK_ORDER_STATE_CHANGED,
      replayed('LOST'),
    );
  });

  it('leaves an order lost to a kernel reset to the restore instead of closing its task', async () => {
    const { service, events } = setup({
      kernelState: null,
      kernelIntact: false,
    });

    await service.run();

    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it.each(['FINISHED', 'FAILED', 'UNROUTABLE', 'WITHDRAWN'])(
    'replays a missed kernel %s',
    async (state) => {
      const { service, events } = setup({ kernelState: state });

      await service.run();

      expect(events.emitAsync).toHaveBeenCalledWith(
        FMS_EVENTS.TASK_ORDER_STATE_CHANGED,
        replayed(state),
      );
    },
  );

  it.each(['RAW', 'DISPATCHABLE', 'BEING_PROCESSED'])(
    'leaves a %s order alone',
    async (state) => {
      const { service, events } = setup({ kernelState: state });

      await service.run();

      expect(events.emitAsync).not.toHaveBeenCalled();
    },
  );

  it('retries later when the kernel cannot be asked', async () => {
    const { service, events } = setup({ kernelState: new Error('timeout') });

    await service.run();

    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it('does nothing while the kernel stream is down', async () => {
    const { service, taskOrders, kernelApi } = setup({
      kernelState: null,
      connected: false,
    });

    await service.run();

    expect(taskOrders.openOrdersOn).not.toHaveBeenCalled();
    expect(kernelApi.getTransportOrderStateStrict).not.toHaveBeenCalled();
  });

  it('skips the order a replacement is swapping out', async () => {
    const { service, kernelApi } = setup({
      kernelState: null,
      replacingOrderName: 'PARK-1',
    });

    await service.run();

    expect(kernelApi.getTransportOrderStateStrict).not.toHaveBeenCalled();
  });

  it('asks only for open orders of the loaded map that had time to reach the kernel', async () => {
    const { service, taskOrders } = setup({ kernelState: 'BEING_PROCESSED' });
    const before = Date.now();

    await service.run();

    const [mapRecordId, createdBefore] = taskOrders.openOrdersOn.mock
      .calls[0] as [string, Date];
    const age = before - createdBefore.getTime();
    expect(typeof mapRecordId).toBe('string');
    expect(age).toBeGreaterThanOrEqual(10_000);
    expect(age).toBeLessThan(11_000);
  });

  it('trusts an order the vehicle is driving right now', async () => {
    const { service, kernelApi } = setup({
      kernelState: null,
      driving: 'PARK-1',
    });

    await service.run();

    expect(kernelApi.getTransportOrderStateStrict).not.toHaveBeenCalled();
  });

  it.each([null, 'WITHDRAWN', 'FAILED'])(
    'settles a withdrawal that was interrupted once the kernel shows %s',
    async (kernelState) => {
      const { service, taskOrders, events } = setup({
        kernelState,
        row: { state: TaskOrderState.WITHDRAWING, endReason: 'why' },
      });

      await service.run();

      expect(taskOrders.onWithdrawn).toHaveBeenCalledWith(
        expect.objectContaining({ orderName: 'PARK-1', reason: 'why' }),
      );
      expect(events.emitAsync).not.toHaveBeenCalled();
    },
  );

  it('reopens an interrupted withdrawal whose order still runs on the kernel', async () => {
    const { service, taskOrders, events } = setup({
      kernelState: 'BEING_PROCESSED',
      row: { state: TaskOrderState.WITHDRAWING },
    });

    await service.run();

    expect(taskOrders.onWithdrawRefused).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: 'PARK-1' }),
    );
    expect(events.emitAsync).not.toHaveBeenCalled();
  });
});
