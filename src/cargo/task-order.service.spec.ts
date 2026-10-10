import { In, IsNull } from 'typeorm';
import { TaskOrderService } from './task-order.service';
import { TaskOrderState } from './entities/task-order.entity';
import {
  FmsTaskOrderStateEvent,
  TASK_ORDER_EVENTS,
  TaskOrderIssuedEvent,
  TaskOrderWithdrawingEvent,
} from './domain/events';

function setup(row: Record<string, unknown> | null) {
  const insert = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
  };
  const repo = {
    maximum: jest.fn().mockResolvedValue(2),
    createQueryBuilder: jest.fn().mockReturnValue(insert),
    findOne: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
  };
  const events = { emit: jest.fn() };
  const taskRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: 'task-1',
      mapRecordId: 'map-1',
    }),
  };
  const agvRepo = {
    find: jest.fn().mockResolvedValue([{ id: 'agv-1' }]),
  };
  const service = new TaskOrderService(
    repo as never,
    taskRepo as never,
    agvRepo as never,
    events as never,
  );
  return { service, repo, insert, events, taskRepo, agvRepo };
}

const activeRow = (leg = 'MANUAL') => ({
  id: 'row-1',
  taskId: 'task-1',
  orderName: 'O-1',
  leg,
  vehicleName: null,
  startedAt: null,
  state: TaskOrderState.ACTIVE,
});

describe('TaskOrderService', () => {
  it('records an issued order after the last one of the task', async () => {
    const { service, insert } = setup(null);

    await service.onIssued(
      new TaskOrderIssuedEvent('task-1', 'O-1', 'MANUAL', 'V1', [
        { locationName: 'L1', operation: 'NOP' },
      ]),
    );

    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        orderName: 'O-1',
        leg: 'MANUAL',
        vehicleName: 'V1',
        seq: 3,
      }),
    );
  });

  it('marks an active order as being withdrawn before the kernel is asked', async () => {
    const { service, repo } = setup(null);

    await service.onWithdrawing(
      new TaskOrderWithdrawingEvent('O-1', 'why', null),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { orderName: 'O-1', state: TaskOrderState.ACTIVE },
      { state: TaskOrderState.WITHDRAWING, endReason: 'why' },
    );
  });

  it('reopens an order whose withdrawal the kernel refused', async () => {
    const { service, repo } = setup(null);

    await service.onWithdrawRefused(
      new TaskOrderWithdrawingEvent('O-1', 'why', null),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { orderName: 'O-1', state: TaskOrderState.WITHDRAWING },
      { state: TaskOrderState.ACTIVE, endReason: null },
    );
  });

  it('ends a replaced order once the kernel accepted the withdrawal', async () => {
    const { service, repo } = setup(null);

    await service.onWithdrawn(
      new TaskOrderWithdrawingEvent('O-1', 'why', 'O-2'),
    );

    expect(repo.update).toHaveBeenCalledWith(
      {
        orderName: 'O-1',
        state: In([
          TaskOrderState.ACTIVE,
          TaskOrderState.WITHDRAWING,
          TaskOrderState.REPLACED,
        ]),
      },
      expect.objectContaining({
        state: TaskOrderState.REPLACED,
        replacedBy: 'O-2',
      }),
    );
  });

  it('ends only an order still open on a plain withdrawal', async () => {
    const { service, repo } = setup(null);

    await service.onWithdrawn(
      new TaskOrderWithdrawingEvent('O-1', 'why', null),
    );

    expect(repo.update).toHaveBeenCalledWith(
      {
        orderName: 'O-1',
        state: In([TaskOrderState.ACTIVE, TaskOrderState.WITHDRAWING]),
      },
      expect.objectContaining({ state: TaskOrderState.WITHDRAWN }),
    );
  });

  it('does not report its own withdrawal as an external one when the kernel event arrives first', async () => {
    const { service, events } = setup({
      ...activeRow('PARK'),
      state: TaskOrderState.WITHDRAWING,
    });

    await service.onKernelState(
      new FmsTaskOrderStateEvent('O-1', 'task-1', 'PARK', 'WITHDRAWN', 'V1'),
    );

    expect(events.emit).not.toHaveBeenCalledWith(
      TASK_ORDER_EVENTS.ENDED,
      expect.anything(),
    );
  });

  it('ends the row as REPLACED before its successor exists', async () => {
    const { service, repo } = setup(null);

    await service.beginReplacement('O-1', 'why');

    expect(repo.update).toHaveBeenCalledWith(
      { orderName: 'O-1', state: TaskOrderState.ACTIVE },
      expect.objectContaining({
        state: TaskOrderState.REPLACED,
        endReason: 'why',
      }),
    );
  });

  it('reopens a replacement that never got a successor', async () => {
    const { service, repo } = setup(null);

    await service.abortReplacement('O-1');

    expect(repo.update).toHaveBeenCalledWith(
      {
        orderName: 'O-1',
        state: TaskOrderState.REPLACED,
        replacedBy: IsNull(),
      },
      { state: TaskOrderState.ACTIVE, endReason: null, endedAt: null },
    );
  });

  it.each([
    ['BEING_PROCESSED', 'MANUAL', 'STARTED'],
    ['FINISHED', 'MANUAL', 'FINISHED'],
    ['FAILED', 'CHARGE', 'FAILED'],
    ['UNROUTABLE', 'MANUAL', 'FAILED'],
    ['WITHDRAWN', 'PARK', 'PREEMPTED'],
    ['WITHDRAWN', 'MANUAL', 'WITHDRAWN_EXTERNALLY'],
    ['LOST', 'PARK', 'LOST'],
  ])(
    'reports kernel %s of a %s order as %s',
    async (orderState, leg, outcome) => {
      const { service, events } = setup(activeRow(leg));

      await service.onKernelState(
        new FmsTaskOrderStateEvent('O-1', 'task-1', leg, orderState, 'V1'),
      );

      expect(events.emit).toHaveBeenCalledWith(
        TASK_ORDER_EVENTS.ENDED,
        expect.objectContaining({ outcome, vehicleName: 'V1' }),
      );
    },
  );

  it('stays quiet about orders WES itself withdrew or replaced', async () => {
    const { service, events } = setup({
      ...activeRow(),
      state: TaskOrderState.REPLACED,
    });

    await service.onKernelState(
      new FmsTaskOrderStateEvent('O-1', 'task-1', 'MANUAL', 'FAILED', 'V1'),
    );

    expect(events.emit).not.toHaveBeenCalledWith(
      TASK_ORDER_EVENTS.ENDED,
      expect.anything(),
    );
  });

  it('records the exact kernel state, first start time and resolved AGV', async () => {
    const { service, repo, events } = setup(activeRow());

    await service.onKernelState(
      new FmsTaskOrderStateEvent(
        'O-1',
        'task-1',
        'MANUAL',
        'BEING_PROCESSED',
        'V1',
      ),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'row-1' },
      expect.objectContaining({
        kernelState: 'BEING_PROCESSED',
        vehicleName: 'V1',
        agvId: 'agv-1',
        startedAt: expect.any(Date),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      TASK_ORDER_EVENTS.ENDED,
      expect.objectContaining({ outcome: 'STARTED' }),
    );
  });

  it('updates an existing DB order even when an old kernel order has no WES properties', async () => {
    const { service, repo } = setup(activeRow('PICKUP'));

    await service.onKernelState(
      new FmsTaskOrderStateEvent('O-1', null, null, 'FINISHED', 'V1'),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'row-1', state: TaskOrderState.ACTIVE },
      expect.objectContaining({
        state: TaskOrderState.FINISHED,
        kernelState: 'FINISHED',
      }),
    );
  });
  it('records how many destinations the kernel reported finished', async () => {
    const { service, repo } = setup({
      ...activeRow(),
      finishedDestinations: 0,
    });

    await service.onKernelState(
      new FmsTaskOrderStateEvent(
        'O-1',
        'task-1',
        'MANUAL',
        'BEING_PROCESSED',
        'V1',
        1,
      ),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'row-1' },
      expect.objectContaining({ finishedDestinations: 1 }),
    );
  });

  it('never lets a late event move the destination progress backwards', async () => {
    const { service, repo } = setup({
      ...activeRow(),
      finishedDestinations: 2,
    });

    await service.onKernelState(
      new FmsTaskOrderStateEvent(
        'O-1',
        'task-1',
        'MANUAL',
        'BEING_PROCESSED',
        'V1',
        1,
      ),
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'row-1' },
      expect.objectContaining({ finishedDestinations: 2 }),
    );
  });
  it('announces every write so readers of the ledger can follow it', async () => {
    const { service, events } = setup(activeRow());

    await service.onKernelState(
      new FmsTaskOrderStateEvent(
        'O-1',
        'task-1',
        'MANUAL',
        'DISPATCHABLE',
        'V1',
      ),
    );
    await service.onWithdrawing(
      new TaskOrderWithdrawingEvent('O-1', 'why', null),
    );

    expect(
      events.emit.mock.calls.filter(
        ([name]: unknown[]) => name === TASK_ORDER_EVENTS.CHANGED,
      ),
    ).toEqual([
      [TASK_ORDER_EVENTS.CHANGED, { orderName: 'O-1' }],
      [TASK_ORDER_EVENTS.CHANGED, { orderName: 'O-1' }],
    ]);
  });
  it('completes a row the kernel event created first, which could not know the destinations', async () => {
    const { service, insert } = setup(null);
    const destinations = [{ locationName: 'L1', operation: 'NOP' }];

    await service.onIssued(
      new TaskOrderIssuedEvent('task-1', 'O-1', 'MANUAL', 'V1', destinations),
    );

    expect(insert.set).toHaveBeenCalledWith({ destinations });
    expect(insert.where).toHaveBeenCalledWith('order_name = :orderName', {
      orderName: 'O-1',
    });
    expect(insert.andWhere).toHaveBeenCalledWith(
      'jsonb_array_length(destinations) = 0',
    );
  });

  it('does not touch stored destinations when the kernel event has none to offer', async () => {
    const { service, insert } = setup(null);

    await service.onKernelState(
      new FmsTaskOrderStateEvent('O-1', 'task-1', 'MANUAL', 'RAW', null),
    );

    expect(insert.set).not.toHaveBeenCalled();
  });
});
