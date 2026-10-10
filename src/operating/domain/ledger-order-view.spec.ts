import {
  TaskOrderState,
  type TaskOrderEntity,
} from '../../cargo/entities/task-order.entity';
import {
  toOrderDetailFromLedger,
  toOrderDtoFromLedger,
} from './ledger-order-view';

const row = (overrides: Partial<TaskOrderEntity> = {}): TaskOrderEntity =>
  ({
    id: 'row-1',
    taskId: 'task-1',
    seq: 1,
    leg: 'PICKUP',
    orderName: 'PICKUP-V1-L1-uuid',
    vehicleName: 'V1',
    destinations: [{ locationName: 'L1', operation: 'liftUp' }],
    state: TaskOrderState.ACTIVE,
    kernelState: 'DISPATCHABLE',
    createdAt: new Date('2026-10-04T01:00:00Z'),
    startedAt: null,
    endedAt: null,
    ...overrides,
  }) as TaskOrderEntity;

describe('toOrderDtoFromLedger', () => {
  it('shows an order waiting for its vehicle as the kernel last reported it', () => {
    expect(toOrderDtoFromLedger(row())).toEqual({
      name: 'PICKUP-V1-L1-uuid',
      type: 'PICKUP',
      state: 'DISPATCHABLE',
      processingVehicle: null,
      intendedVehicle: 'V1',
      wrappingSequence: null,
      destinations: [{ locationName: 'L1', operation: 'liftUp' }],
      creationTime: '2026-10-04T01:00:00.000Z',
      finishedTime: null,
      taskId: 'task-1',
    });
  });

  it('names the vehicle as processing once the order started', () => {
    const dto = toOrderDtoFromLedger(
      row({
        kernelState: 'BEING_PROCESSED',
        startedAt: new Date('2026-10-04T01:00:05Z'),
      }),
    );

    expect(dto).toMatchObject({
      state: 'BEING_PROCESSED',
      processingVehicle: 'V1',
    });
  });

  it('keeps an order being withdrawn in the state the kernel still reports', () => {
    const dto = toOrderDtoFromLedger(
      row({
        state: TaskOrderState.WITHDRAWING,
        kernelState: 'BEING_PROCESSED',
      }),
    );

    expect(dto.state).toBe('BEING_PROCESSED');
  });

  it('shows a finished order with the time it ended', () => {
    const dto = toOrderDtoFromLedger(
      row({
        state: TaskOrderState.FINISHED,
        kernelState: 'FINISHED',
        endedAt: new Date('2026-10-04T01:03:00Z'),
      }),
    );

    expect(dto).toMatchObject({
      state: 'FINISHED',
      finishedTime: '2026-10-04T01:03:00.000Z',
    });
  });

  it.each([
    TaskOrderState.FAILED,
    TaskOrderState.WITHDRAWN,
    TaskOrderState.REPLACED,
    TaskOrderState.PREEMPTED,
  ])(
    'shows an order that ended as %s as a failed one, with no finish time',
    (state) => {
      const dto = toOrderDtoFromLedger(
        row({ state, endedAt: new Date('2026-10-04T01:03:00Z') }),
      );

      expect(dto).toMatchObject({ state: 'FAILED', finishedTime: null });
    },
  );

  it('tolerates a legacy row without destinations', () => {
    const dto = toOrderDtoFromLedger(row({ destinations: undefined as never }));

    expect(dto.destinations).toEqual([]);
  });
});

describe('toOrderDetailFromLedger', () => {
  const threePoints = [
    { locationName: 'A', operation: 'MOVE' },
    { locationName: 'B', operation: 'MOVE' },
    { locationName: 'C', operation: 'MOVE' },
  ];

  it('describes an order from the ledger alone when the kernel has nothing to add', () => {
    const detail = toOrderDetailFromLedger(
      row({
        destinations: threePoints,
        finishedDestinations: 1,
        kernelState: 'BEING_PROCESSED',
        startedAt: new Date('2026-10-04T01:00:05Z'),
      }),
      null,
    );

    expect(detail).toMatchObject({
      name: 'PICKUP-V1-L1-uuid',
      state: 'BEING_PROCESSED',
      processingVehicle: 'V1',
      currentDriveOrderIndex: 1,
    });
    expect(
      (detail.driveOrders as { state: string }[]).map((drive) => drive.state),
    ).toEqual(['FINISHED', 'TRAVELLING', 'PRISTINE']);
    expect(
      (detail.history as { entries: { eventCode: string }[] }).entries.map(
        (entry) => entry.eventCode,
      ),
    ).toEqual(['wes:orderIssued', 'wes:orderStarted']);
  });

  it('marks what was left undone when the order ended without finishing', () => {
    const detail = toOrderDetailFromLedger(
      row({
        destinations: threePoints,
        finishedDestinations: 1,
        state: TaskOrderState.WITHDRAWN,
        endReason: 'cargo deleted',
        endedAt: new Date('2026-10-04T01:03:00Z'),
      }),
      null,
    );

    expect(
      (detail.driveOrders as { state: string }[]).map((drive) => drive.state),
    ).toEqual(['FINISHED', 'FAILED', 'FAILED']);
    expect(
      (
        detail.history as {
          entries: { eventCode: string; supplements: string[] }[];
        }
      ).entries.at(-1),
    ).toMatchObject({
      eventCode: 'wes:orderEnded',
      supplements: ['WITHDRAWN', 'cargo deleted'],
    });
  });

  it('adds the route and history only the kernel has, while the ledger decides who and what state', () => {
    const detail = toOrderDetailFromLedger(
      row({ state: TaskOrderState.FINISHED, kernelState: 'FINISHED' }),
      {
        state: 'BEING_PROCESSED',
        deadline: '2026-10-05T00:00:00Z',
        driveOrders: [{ name: 'd0', state: 'FINISHED', route: { costs: 7 } }],
        history: { entries: [{ eventCode: 'tcs:history:orderCreated' }] },
      },
    );

    expect(detail).toMatchObject({
      state: 'FINISHED',
      deadline: '2026-10-05T00:00:00Z',
      driveOrders: [{ name: 'd0', route: { costs: 7 } }],
      history: { entries: [{ eventCode: 'tcs:history:orderCreated' }] },
    });
  });
});
