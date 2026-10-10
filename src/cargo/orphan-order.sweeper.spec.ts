import { OrphanOrderSweeper } from './orphan-order.sweeper';
import { TaskOrderState } from './entities/task-order.entity';
import { TaskKind, TaskStatus } from './entities/transport-task.entity';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

const oldRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'row-1',
  taskId: 'task-1',
  seq: 2,
  leg: 'APPROACH',
  orderName: 'APPROACH-V1-SLOT-1-x',
  vehicleName: 'V1',
  state: TaskOrderState.ACTIVE,
  createdAt: new Date(Date.now() - 60_000),
  ...overrides,
});

function setup(status: TaskStatus, kernelState: string | null) {
  const taskOrderRepo = {
    find: jest.fn().mockResolvedValue([oldRow()]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const taskRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: 'task-1',
        requestCode: 'TR-1',
        kind: TaskKind.CARGO,
        status,
        mapRecordId: 'map-1',
      },
    ]),
  };
  const kernelApi = {
    getTransportOrderStateStrict: jest.fn().mockResolvedValue(kernelState),
  };
  const transportOrders = { cancel: jest.fn().mockResolvedValue(undefined) };
  const sweeper = new OrphanOrderSweeper(
    taskRepo as never,
    taskOrderRepo as never,
    kernelApi as never,
    transportOrders as never,
    fixedActiveMap(),
  );
  return { sweeper, taskOrderRepo, transportOrders };
}

describe('OrphanOrderSweeper', () => {
  it('withdraws an order the kernel still runs for a task that has ended', async () => {
    const { sweeper, transportOrders } = setup(
      TaskStatus.DELIVERY_COMPLETED,
      'BEING_PROCESSED',
    );

    await sweeper.run();

    expect(transportOrders.cancel).toHaveBeenCalledWith(
      'APPROACH-V1-SLOT-1-x',
      expect.objectContaining({ immediate: false }),
    );
  });

  it('only closes the row when the kernel has already ended the order', async () => {
    const { sweeper, transportOrders, taskOrderRepo } = setup(
      TaskStatus.DELIVERY_COMPLETED,
      'FINISHED',
    );

    await sweeper.run();

    expect(transportOrders.cancel).not.toHaveBeenCalled();
    expect(taskOrderRepo.update).toHaveBeenCalledWith(
      { id: 'row-1', state: TaskOrderState.ACTIVE },
      expect.objectContaining({ state: TaskOrderState.FINISHED }),
    );
  });

  it('leaves the orders of a live task alone', async () => {
    const { sweeper, transportOrders, taskOrderRepo } = setup(
      TaskStatus.DELIVERING,
      'BEING_PROCESSED',
    );

    await sweeper.run();

    expect(transportOrders.cancel).not.toHaveBeenCalled();
    expect(taskOrderRepo.update).not.toHaveBeenCalled();
  });
});
