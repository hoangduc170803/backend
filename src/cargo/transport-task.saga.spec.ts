import { TransportTaskSaga } from './transport-task.saga';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { FmsTransportOrderFinishedEvent } from './domain/events';
import { CargoStatus } from './entities/cargo.entity';
import { TaskStatus } from './entities/transport-task.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../maps/infrastructure/active-map-context.testing';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeSaga(findOne: jest.Mock): TransportTaskSaga {
  const taskRepo = { findOne };
  return new TransportTaskSaga(
    taskRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    fixedActiveMap(),
    { markPresent: jest.fn().mockResolvedValue(null) } as never,
    { ordersOf: jest.fn().mockResolvedValue([]) } as never,
  );
}

describe('TransportTaskSaga single-flight', () => {
  const event = () =>
    new FmsTransportOrderFinishedEvent('PICKUP-1', 'task-1', 'PICKUP');

  it('drops a duplicate finished-event while the task is already in flight', async () => {
    const d = deferred<null>();
    const findOne = jest.fn().mockReturnValue(d.promise);
    const saga = makeSaga(findOne);

    const p1 = saga.onTransportOrderFinished(event());
    const p2 = saga.onTransportOrderFinished(event());

    await p2;
    expect(findOne).toHaveBeenCalledTimes(1);

    d.resolve(null);
    await p1;
  });

  it('handles the task again once the previous handling has finished', async () => {
    const d1 = deferred<null>();
    const findOne = jest.fn().mockReturnValue(d1.promise);
    const saga = makeSaga(findOne);

    const p1 = saga.onTransportOrderFinished(event());
    d1.resolve(null);
    await p1;

    const d2 = deferred<null>();
    findOne.mockReturnValue(d2.promise);
    const p2 = saga.onTransportOrderFinished(event());
    d2.resolve(null);
    await p2;

    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even if handling throws', async () => {
    const findOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(null);
    const saga = makeSaga(findOne);

    await expect(saga.onTransportOrderFinished(event())).rejects.toThrow(
      'boom',
    );
    await saga.onTransportOrderFinished(event());
    expect(findOne).toHaveBeenCalledTimes(2);
  });
});

const SLOT = 'location_3003';

function makeDeliverySaga(
  options: {
    task?: Record<string, unknown>;
    cargo?: Record<string, unknown> | null;
    zone?: Record<string, unknown> | null;
    reservedSlot?: string | null;
  } = {},
) {
  const task = {
    id: 'task-1',
    mapRecordId: TEST_MAP_ID,
    status: TaskStatus.PICKING_UP,
    cargoId: 'cargo-1',
    metadata: { assignedVehicleName: 'V1', pickupOrderName: 'PICKUP-V1-x' },
    ...options.task,
  };
  const cargo =
    options.cargo === null
      ? null
      : { id: 'cargo-1', destinationZoneId: 'zone-1', ...options.cargo };

  const taskRepo = {
    findOne: jest.fn().mockResolvedValue(task),
    save: jest.fn().mockResolvedValue(task),
  };
  const cargoRepo = {
    findOne: jest.fn().mockResolvedValue(cargo),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const zoneRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        options.zone === null ? null : { id: 'zone-1', name: 'zone_1' },
      ),
  };
  const kernelApi = {
    unloadOperation: 'liftDown',
    createTransportOrder: jest.fn().mockResolvedValue(undefined),
  };
  const transportTask = {
    changeStatus: jest.fn().mockResolvedValue(undefined),
  };
  const slotReservation = {
    reserve: jest
      .fn()
      .mockResolvedValue(
        options.reservedSlot === undefined ? SLOT : options.reservedSlot,
      ),
  };
  const dropoffOrder = {
    issue: jest.fn().mockResolvedValue('DROPOFF-V1-location_3003-y'),
  };
  const retreatPoint = {
    planFor: jest
      .fn()
      .mockResolvedValue({ cells: ['3002', '3001'], egress: null }),
  };
  const approachOrder = { aim: jest.fn().mockResolvedValue('APPROACH-V1-x') };
  const deliverySlotEngine = {
    layoutFor: jest.fn().mockResolvedValue({
      lanes: [
        {
          axis: 0,
          slots: [{ locationName: SLOT, pointName: '3003' }],
          axisPoints: ['3003', '3002', '3001'],
        },
      ],
    }),
  };

  const saga = new TransportTaskSaga(
    taskRepo as never,
    cargoRepo as never,
    zoneRepo as never,
    kernelApi as never,
    new TransportOrderService(kernelApi as never),
    transportTask as never,
    slotReservation as never,
    dropoffOrder as never,
    retreatPoint as never,
    approachOrder as never,
    deliverySlotEngine as never,
    fixedActiveMap(),
    { markPresent: jest.fn().mockResolvedValue(null) } as never,
    { ordersOf: jest.fn().mockResolvedValue([]) } as never,
  );

  return {
    saga,
    task,
    taskRepo,
    cargoRepo,
    kernelApi,
    transportTask,
    slotReservation,
    dropoffOrder,
    retreatPoint,
    approachOrder,
  };
}

const pickupFinished = () =>
  new FmsTransportOrderFinishedEvent('PICKUP-V1-x', 'task-1', 'PICKUP');

describe('TransportTaskSaga pick-up finished', () => {
  it('reserves a slot and aims the approach order straight at it', async () => {
    const { saga, slotReservation, approachOrder } = makeDeliverySaga();

    await saga.onTransportOrderFinished(pickupFinished());

    expect(slotReservation.reserve).toHaveBeenCalledWith(
      'cargo-1',
      { id: 'zone-1', name: 'zone_1' },
      'V1',
    );
    expect(approachOrder.aim).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      'V1',
      { locationName: SLOT },
    );
  });

  it('ignores a finished leg of a task that belongs to another map', async () => {
    const { saga, slotReservation, approachOrder, transportTask } =
      makeDeliverySaga({ task: { mapRecordId: 'another-map' } });

    await saga.onTransportOrderFinished(pickupFinished());

    expect(slotReservation.reserve).not.toHaveBeenCalled();
    expect(approachOrder.aim).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('never issues the drop-off order before a lane is free', async () => {
    const { saga, dropoffOrder } = makeDeliverySaga();

    await saga.onTransportOrderFinished(pickupFinished());

    expect(dropoffOrder.issue).not.toHaveBeenCalled();
  });

  it('moves the task to DELIVERING once the drop-off order is out', async () => {
    const { saga, transportTask, task } = makeDeliverySaga();

    await saga.onTransportOrderFinished(pickupFinished());

    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      task,
      TaskStatus.DELIVERING,
      expect.objectContaining({ trigger: 'SAGA' }),
    );
  });

  it('holds the task in PICKING_UP when the approach order cannot go out', async () => {
    const { saga, transportTask, approachOrder } = makeDeliverySaga();
    approachOrder.aim.mockResolvedValueOnce(null);

    await saga.onTransportOrderFinished(pickupFinished());

    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('holds the task in PICKING_UP when the zone offers no slot to reserve', async () => {
    const { saga, transportTask, dropoffOrder } = makeDeliverySaga({
      reservedSlot: null,
    });

    await saga.onTransportOrderFinished(pickupFinished());

    expect(dropoffOrder.issue).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('fails the task when the cargo has no destination zone', async () => {
    const { saga, transportTask, dropoffOrder } = makeDeliverySaga({
      zone: null,
    });

    await saga.onTransportOrderFinished(pickupFinished());

    expect(dropoffOrder.issue).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      expect.anything(),
      TaskStatus.FAILED,
      expect.objectContaining({ trigger: 'SAGA' }),
    );
  });

  it('ignores a duplicate pick-up finished once the drop-off order exists', async () => {
    const { saga, slotReservation, dropoffOrder } = makeDeliverySaga({
      task: {
        metadata: {
          assignedVehicleName: 'V1',
          dropoffOrderName: 'DROPOFF-V1-location_3003-y',
        },
      },
    });

    await saga.onTransportOrderFinished(pickupFinished());

    expect(slotReservation.reserve).not.toHaveBeenCalled();
    expect(dropoffOrder.issue).not.toHaveBeenCalled();
  });
});

describe('TransportTaskSaga drop-off completion', () => {
  const dropOffFinished = () =>
    new FmsTransportOrderFinishedEvent(
      'DROPOFF-V1-location_3003-y',
      'task-1',
      'DROPOFF',
    );

  it('completes the task and marks the cargo delivered after the retreat', async () => {
    const { saga, transportTask, cargoRepo, task } = makeDeliverySaga({
      task: { status: TaskStatus.DELIVERING },
    });

    await saga.onTransportOrderFinished(dropOffFinished());

    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      task,
      TaskStatus.DELIVERY_COMPLETED,
      { trigger: 'SAGA' },
    );
    expect(cargoRepo.update).toHaveBeenCalledWith('cargo-1', {
      status: CargoStatus.DELIVERED,
      deliveredAt: expect.any(Date),
    });
  });
});
