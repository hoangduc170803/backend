import {
  OrderReplacementService,
  remainingDestinations,
} from './order-replacement.service';
import { TaskOrderState } from './entities/task-order.entity';
import { TaskKind, TaskStatus } from './entities/transport-task.entity';
import { TASK_ORDER_EVENTS } from './domain/events';

const KERNEL_ORDER = {
  state: 'BEING_PROCESSED',
  processingVehicle: 'V1',
  destinations: [
    { locationName: 'SLOT-1', operation: 'liftDown', state: 'FINISHED' },
    { locationName: '3002', operation: 'MOVE', state: 'TRAVELLING' },
    { locationName: '3001', operation: 'MOVE', state: 'PRISTINE' },
  ],
};

function setup(
  row: Record<string, unknown> | null,
  kernelOrder: unknown = KERNEL_ORDER,
) {
  const task = {
    id: 'task-1',
    requestCode: 'TR-1',
    kind: TaskKind.CARGO,
    status: TaskStatus.DELIVERING,
    metadata: {
      dropoffOrderName:
        'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000001',
      assignedVehicleName: 'V1',
    },
  };
  const taskRepo = {
    findOne: jest.fn().mockResolvedValue(task),
    save: jest.fn().mockResolvedValue(task),
  };
  const kernelApi = {
    getTransportOrderRaw: jest.fn().mockResolvedValue(kernelOrder),
  };
  const transportOrders = {
    issue: jest
      .fn()
      .mockResolvedValue(
        'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000002',
      ),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const taskOrders = {
    findByOrderName: jest.fn().mockResolvedValue(row),
    ordersOf: jest.fn().mockResolvedValue([row]),
    beginReplacement: jest.fn().mockResolvedValue(undefined),
    abortReplacement: jest.fn().mockResolvedValue(undefined),
  };
  const transportTask = { publishUpdated: jest.fn() };
  const events = { emit: jest.fn() };
  const service = new OrderReplacementService(
    taskRepo as never,
    kernelApi as never,
    transportOrders as never,
    taskOrders as never,
    transportTask as never,
    events as never,
  );
  return { service, task, transportOrders, taskOrders, events };
}

const dropoffRow = {
  taskId: 'task-1',
  orderName: 'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000001',
  leg: 'DROPOFF',
  vehicleName: 'V1',
  state: TaskOrderState.ACTIVE,
  destinations: [
    { locationName: 'SLOT-1', operation: 'liftDown' },
    { locationName: '3002', operation: 'MOVE' },
    { locationName: '3001', operation: 'MOVE' },
  ],
};

describe('OrderReplacementService', () => {
  it('keeps only the destinations the vehicle has not finished yet', () => {
    expect(remainingDestinations(KERNEL_ORDER)).toEqual([
      { locationName: '3002', operation: 'MOVE' },
      { locationName: '3001', operation: 'MOVE' },
    ]);
  });

  it('withdraws a raw order that belongs to no task', async () => {
    const { service, transportOrders } = setup(null);

    const result = await service.withdrawFromOrdersTab('OP-1');

    expect(result.replacedBy).toBeNull();
    expect(transportOrders.issue).not.toHaveBeenCalled();
    expect(transportOrders.cancel).toHaveBeenCalledWith(
      'OP-1',
      expect.objectContaining({ immediate: true }),
    );
  });

  it('re-issues the rest of a task order for the same vehicle, then withdraws the old one', async () => {
    const { service, task, transportOrders, events } = setup(dropoffRow);

    const result = await service.withdrawFromOrdersTab(
      'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000001',
    );

    expect(transportOrders.issue).toHaveBeenCalledWith({
      kind: 'DROPOFF',
      vehicleName: 'V1',
      aimedAt: 'SLOT-1',
      destinations: [
        { locationName: '3002', operation: 'MOVE' },
        { locationName: '3001', operation: 'MOVE' },
      ],
      taskId: 'task-1',
      dispensable: false,
    });
    expect(task.metadata.dropoffOrderName).toBe(
      'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000002',
    );
    expect(transportOrders.cancel).toHaveBeenCalledWith(
      'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000001',
      expect.objectContaining({
        immediate: true,
        replacedBy: 'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000002',
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      TASK_ORDER_EVENTS.REPLACED,
      expect.objectContaining({
        newOrderName: 'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000002',
      }),
    );
    expect(result.replacedBy).toBe(
      'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000002',
    );
  });

  it('ends the old row before issuing, so the kernel dropping a dispensable order is not a pre-emption', async () => {
    const { service, transportOrders, taskOrders } = setup({
      ...dropoffRow,
      leg: 'PARK',
      orderName: 'PARK-V1-0200-00000000-0000-4000-8000-000000000001',
    });

    await service.withdrawFromOrdersTab(
      'PARK-V1-0200-00000000-0000-4000-8000-000000000001',
    );

    expect(taskOrders.beginReplacement).toHaveBeenCalledWith(
      'PARK-V1-0200-00000000-0000-4000-8000-000000000001',
      expect.any(String),
    );
    expect(
      taskOrders.beginReplacement.mock.invocationCallOrder[0],
    ).toBeLessThan(transportOrders.issue.mock.invocationCallOrder[0]);
    expect(transportOrders.issue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'PARK', dispensable: true }),
    );
    expect(taskOrders.abortReplacement).not.toHaveBeenCalled();
  });

  it('just withdraws when nothing is left to drive', async () => {
    const { service, transportOrders } = setup(dropoffRow, {
      state: 'BEING_PROCESSED',
      destinations: [{ locationName: 'SLOT-1', state: 'FINISHED' }],
    });

    const result = await service.withdrawFromOrdersTab(
      'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000001',
    );

    expect(result.replacedBy).toBeNull();
    expect(transportOrders.issue).not.toHaveBeenCalled();
  });

  it('keeps the old order untouched when the new one cannot be issued', async () => {
    const { service, task, transportOrders, taskOrders } = setup(dropoffRow);
    transportOrders.issue.mockRejectedValueOnce(new Error('kernel down'));

    await expect(
      service.withdrawFromOrdersTab(
        'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toThrow('kernel down');

    expect(transportOrders.cancel).not.toHaveBeenCalled();
    expect(taskOrders.abortReplacement).toHaveBeenCalledWith(
      'DROPOFF-V1-SLOT-1-00000000-0000-4000-8000-000000000001',
    );
    expect(task.metadata).not.toHaveProperty(
      'replacingOrderName',
      expect.anything(),
    );
  });

  it('only withdraws an approach the task has already moved past', async () => {
    const approachRow = {
      id: 'row-approach',
      taskId: 'task-1',
      seq: 2,
      orderName: 'APPROACH-V1-SLOT-1-00000000-0000-4000-8000-000000000003',
      leg: 'APPROACH',
      vehicleName: 'V1',
      state: TaskOrderState.ACTIVE,
    };
    const { service, transportOrders } = setup(approachRow);

    const result = await service.withdrawFromOrdersTab(approachRow.orderName);

    expect(result.replacedBy).toBeNull();
    expect(transportOrders.issue).not.toHaveBeenCalled();
    expect(transportOrders.cancel).toHaveBeenCalledWith(
      approachRow.orderName,
      expect.objectContaining({ immediate: true }),
    );
  });
});
