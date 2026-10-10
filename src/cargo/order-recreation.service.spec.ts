import { OrderRecreationService } from './order-recreation.service';
import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';
import {
  TaskOrderState,
  type TaskOrderEntity,
} from './entities/task-order.entity';
import { TaskOrderEndedEvent } from './domain/events';
import { MAX_ORDER_RECREATIONS } from './domain/order-recreation';

const DROP = [
  { locationName: 'SLOT-1', operation: 'UNLOAD' },
  { locationName: 'RETREAT-1', operation: 'NOP' },
];

function setup(
  taskPatch: Partial<TransportTaskEntity>,
  rowPatch: Partial<TaskOrderEntity>,
  laterRows: Partial<TaskOrderEntity>[] = [],
) {
  const task = {
    id: 'task-1',
    requestCode: 'TR-1',
    kind: TaskKind.CARGO,
    status: TaskStatus.DELIVERING,
    metadata: { assignedVehicleName: 'V1' },
    ...taskPatch,
  } as TransportTaskEntity;
  const row = {
    id: 'row-1',
    taskId: 'task-1',
    seq: 2,
    leg: 'DROPOFF',
    orderName: 'DROPOFF-1',
    vehicleName: 'V1',
    state: TaskOrderState.FAILED,
    destinations: DROP,
    finishedDestinations: 0,
    replacedBy: null,
    ...rowPatch,
  } as TaskOrderEntity;
  const taskRepo = {
    findOne: jest.fn().mockResolvedValue(task),
    save: jest.fn().mockImplementation((saved) => Promise.resolve(saved)),
  };
  const kernelApi = {
    getTransportOrderRaw: jest.fn().mockRejectedValue(new Error('404')),
  };
  const taskOrders = {
    findByOrderName: jest.fn().mockResolvedValue(row),
    ordersOf: jest.fn().mockResolvedValue([row, ...laterRows]),
    endedWithoutSuccessor: jest.fn().mockResolvedValue([row]),
  };
  const replacement = {
    recreateEnded: jest.fn().mockResolvedValue('DROPOFF-2'),
  };
  const transportTask = {
    changeStatus: jest.fn().mockResolvedValue(task),
    publishUpdated: jest.fn(),
  };
  const activeMap = { id: jest.fn().mockResolvedValue('map-1') };
  const service = new OrderRecreationService(
    taskRepo as never,
    kernelApi as never,
    taskOrders as never,
    replacement as never,
    transportTask as never,
    activeMap as never,
  );
  return { service, task, row, kernelApi, replacement, transportTask };
}

const ended = (outcome: TaskOrderEndedEvent['outcome']) =>
  new TaskOrderEndedEvent('task-1', 'DROPOFF-1', 'DROPOFF', outcome, 'V1');

describe('OrderRecreationService', () => {
  it('re-issues a drop-off the FMS ended and counts the attempt', async () => {
    const { service, task, row, replacement } = setup({}, {});

    await expect(service.recreate('task-1', 'DROPOFF-1')).resolves.toBe(
      'recreated',
    );

    expect(replacement.recreateEnded).toHaveBeenCalledWith(
      row,
      task,
      DROP,
      expect.any(String),
    );
    expect(task.metadata?.orderRecreation).toMatchObject({
      count: 1,
      lastOrderName: 'DROPOFF-1',
    });
  });

  it('re-issues only the destinations the kernel had not finished', async () => {
    const { service, kernelApi, replacement } = setup({}, {});
    kernelApi.getTransportOrderRaw.mockResolvedValue({
      destinations: [
        { locationName: 'SLOT-1', operation: 'UNLOAD', state: 'FINISHED' },
        { locationName: 'RETREAT-1', operation: 'NOP', state: 'FAILED' },
      ],
    });

    await service.recreate('task-1', 'DROPOFF-1');

    expect(replacement.recreateEnded).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [{ locationName: 'RETREAT-1', operation: 'NOP' }],
      expect.any(String),
    );
  });

  it('sends an ended pickup back to the queue for any vehicle', async () => {
    const { service, task, replacement, transportTask } = setup(
      {
        status: TaskStatus.PICKING_UP,
        metadata: { assignedVehicleName: 'V1', pickupOrderName: 'PICKUP-1' },
      },
      { leg: 'PICKUP', orderName: 'PICKUP-1', seq: 1 },
    );

    await service.recreate('task-1', 'PICKUP-1');

    expect(replacement.recreateEnded).not.toHaveBeenCalled();
    expect(task.metadata?.assignedVehicleName).toBeUndefined();
    expect(task.metadata?.orderRecreation?.count).toBe(1);
    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      task,
      TaskStatus.READY_TO_ASSIGN,
      expect.objectContaining({ trigger: 'ORDER_RECREATION' }),
    );
  });

  it('re-issues manual and charge orders too', async () => {
    for (const [kind, leg] of [
      [TaskKind.MANUAL, 'MANUAL'],
      [TaskKind.CHARGE, 'CHARGE'],
    ] as const) {
      const { service, replacement } = setup(
        { kind, status: TaskStatus.EXECUTING },
        { leg },
      );

      await service.recreate('task-1', 'DROPOFF-1');

      expect(replacement.recreateEnded).toHaveBeenCalled();
    }
  });

  it('never recreates a park order', async () => {
    const { service, replacement, transportTask } = setup(
      { kind: TaskKind.PARK, status: TaskStatus.EXECUTING },
      { leg: 'PARK' },
    );

    await expect(service.recreate('task-1', 'DROPOFF-1')).resolves.toBe(
      'not-applicable',
    );
    expect(replacement.recreateEnded).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('leaves an order WES itself withdrew or already replaced alone', async () => {
    for (const state of [
      TaskOrderState.WITHDRAWING,
      TaskOrderState.WITHDRAWN,
      TaskOrderState.REPLACED,
      TaskOrderState.FINISHED,
    ]) {
      const { service, replacement } = setup({}, { state });

      await service.recreate('task-1', 'DROPOFF-1');

      expect(replacement.recreateEnded).not.toHaveBeenCalled();
    }
  });

  it('does not recreate an approach whose drop-off is already issued', async () => {
    const { service, replacement } = setup(
      {},
      { leg: 'APPROACH', orderName: 'APPROACH-1' },
      [{ id: 'row-2', seq: 3, leg: 'DROPOFF', state: TaskOrderState.ACTIVE }],
    );

    await service.recreate('task-1', 'APPROACH-1');

    expect(replacement.recreateEnded).not.toHaveBeenCalled();
  });

  it('stops and fails the task once the limit is spent', async () => {
    const { service, task, replacement, transportTask } = setup(
      {
        metadata: {
          assignedVehicleName: 'V1',
          orderRecreation: {
            count: MAX_ORDER_RECREATIONS,
            windowStartedAt: new Date().toISOString(),
            lastOrderName: 'DROPOFF-0',
          },
        },
      },
      {},
    );

    await expect(service.recreate('task-1', 'DROPOFF-1')).resolves.toBe(
      'exhausted',
    );

    expect(replacement.recreateEnded).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      task,
      TaskStatus.FAILED,
      expect.objectContaining({
        trigger: 'ORDER_RECREATION',
        reason: expect.stringContaining(`${MAX_ORDER_RECREATIONS} lần`),
      }),
    );
  });

  it('does not spend the budget when the re-issue fails', async () => {
    const { service, task, replacement } = setup({}, {});
    replacement.recreateEnded.mockRejectedValue(new Error('kernel down'));

    await service.recreate('task-1', 'DROPOFF-1');

    expect(task.metadata?.orderRecreation).toBeUndefined();
  });

  it('reacts to FMS endings only', async () => {
    const { service, replacement } = setup({}, {});

    await service.onOrderEnded(ended('FINISHED'));
    await service.onOrderEnded(ended('PREEMPTED'));
    expect(replacement.recreateEnded).not.toHaveBeenCalled();

    await service.onOrderEnded(ended('WITHDRAWN_EXTERNALLY'));
    expect(replacement.recreateEnded).toHaveBeenCalledTimes(1);
  });

  it('sweeps ended orders that nothing replaced', async () => {
    const { service, replacement } = setup({}, {});

    await service.run();

    expect(replacement.recreateEnded).toHaveBeenCalledTimes(1);
  });
});
