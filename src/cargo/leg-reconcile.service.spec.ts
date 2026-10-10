import { LegReconcileService } from './leg-reconcile.service';
import {
  TransportTaskEntity,
  TaskStatus,
  TaskMetadata,
} from './entities/transport-task.entity';
import { FMS_EVENTS } from './domain/events';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

type Mocked = {
  taskRepo: { find: jest.Mock };
  store: { get: jest.Mock };
  kernel: { getTransportOrderState: jest.Mock };
  transportTask: { changeStatus: jest.Mock };
  emitter: { emit: jest.Mock };
  orderRecreation: { recreate: jest.Mock };
};

function setup(): { svc: LegReconcileService } & Mocked {
  const taskRepo = { find: jest.fn() };
  const taskOrdersOf = jest.fn().mockResolvedValue([]);
  const store = { get: jest.fn() };
  const kernel = { getTransportOrderState: jest.fn() };
  const transportTask = { changeStatus: jest.fn() };
  const emitter = { emit: jest.fn() };
  const orderRecreation = {
    recreate: jest.fn().mockResolvedValue('not-applicable'),
  };
  const svc = new LegReconcileService(
    taskRepo as never,
    store as never,
    kernel as never,
    transportTask as never,
    emitter as never,
    fixedActiveMap(),
    { ordersOf: taskOrdersOf } as never,
    orderRecreation as never,
  );
  return {
    svc,
    taskRepo,
    store,
    kernel,
    transportTask,
    emitter,
    orderRecreation,
  };
}

const task = (
  status: TaskStatus,
  metadata: TaskMetadata,
): TransportTaskEntity =>
  ({ id: 'task-1', status, metadata }) as TransportTaskEntity;

describe('LegReconcileService', () => {
  it('skips (no fetch) when the vehicle is still on the expected leg order', async () => {
    const { svc, taskRepo, store, kernel, emitter } = setup();
    taskRepo.find.mockResolvedValue([
      task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
      }),
    ]);
    store.get.mockReturnValue({ transportOrder: 'PICKUP-1' });

    await svc.run();

    expect(kernel.getTransportOrderState).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('re-fires the finished event when the pickup order is FINISHED but unadvanced', async () => {
    const { svc, taskRepo, store, kernel, emitter } = setup();
    taskRepo.find.mockResolvedValue([
      task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
      }),
    ]);
    store.get.mockReturnValue({ transportOrder: null }); // moved off → idle
    kernel.getTransportOrderState.mockResolvedValue('FINISHED');

    await svc.run();

    expect(kernel.getTransportOrderState).toHaveBeenCalledWith('PICKUP-1');
    expect(emitter.emit).toHaveBeenCalledWith(
      FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
      expect.objectContaining({
        orderName: 'PICKUP-1',
        taskId: 'task-1',
        leg: 'PICKUP',
      }),
    );
  });

  it('resolves the APPROACH leg while delivering before drop-off exists', async () => {
    const { svc, taskRepo, store, kernel, emitter } = setup();
    taskRepo.find.mockResolvedValue([
      task(TaskStatus.DELIVERING, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
        approachOrderName: 'APPROACH-1',
      }),
    ]);
    store.get.mockReturnValue({ transportOrder: null });
    kernel.getTransportOrderState.mockResolvedValue('FINISHED');

    await svc.run();

    expect(kernel.getTransportOrderState).toHaveBeenCalledWith('APPROACH-1');
    expect(emitter.emit).toHaveBeenCalledWith(
      FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
      expect.objectContaining({ orderName: 'APPROACH-1', leg: 'APPROACH' }),
    );
  });

  it('resolves the DROPOFF leg once the drop-off order exists', async () => {
    const { svc, taskRepo, store, kernel, emitter } = setup();
    taskRepo.find.mockResolvedValue([
      task(TaskStatus.DELIVERING, {
        assignedVehicleName: 'V1',
        approachOrderName: 'APPROACH-1',
        dropoffOrderName: 'DROPOFF-1',
      }),
    ]);
    store.get.mockReturnValue({ transportOrder: 'something-else' });
    kernel.getTransportOrderState.mockResolvedValue('FINISHED');

    await svc.run();

    expect(kernel.getTransportOrderState).toHaveBeenCalledWith('DROPOFF-1');
    expect(emitter.emit).toHaveBeenCalledWith(
      FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
      expect.objectContaining({ orderName: 'DROPOFF-1', leg: 'DROPOFF' }),
    );
  });

  it('fails the task when the ended order has no ledger row to recreate from', async () => {
    for (const bad of ['FAILED', 'UNROUTABLE']) {
      const { svc, taskRepo, store, kernel, transportTask, emitter } = setup();
      const t = task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
      });
      taskRepo.find.mockResolvedValue([t]);
      store.get.mockReturnValue({ transportOrder: null });
      kernel.getTransportOrderState.mockResolvedValue(bad);

      await svc.run();

      expect(transportTask.changeStatus).toHaveBeenCalledWith(
        t,
        TaskStatus.FAILED,
        expect.objectContaining({ trigger: 'LEG_RECONCILE' }),
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    }
  });

  it('hands an order the FMS ended to the recreation service instead of failing', async () => {
    for (const bad of ['FAILED', 'UNROUTABLE']) {
      const { svc, taskRepo, store, kernel, transportTask, orderRecreation } =
        setup();
      orderRecreation.recreate.mockResolvedValue('recreated');
      taskRepo.find.mockResolvedValue([
        task(TaskStatus.DELIVERING, {
          assignedVehicleName: 'V1',
          approachOrderName: 'APPROACH-1',
          dropoffOrderName: 'DROPOFF-1',
        }),
      ]);
      store.get.mockReturnValue({ transportOrder: null });
      kernel.getTransportOrderState.mockResolvedValue(bad);

      await svc.run();

      expect(orderRecreation.recreate).toHaveBeenCalledWith(
        expect.any(String),
        'DROPOFF-1',
      );
      expect(transportTask.changeStatus).not.toHaveBeenCalled();
    }
  });

  it('does nothing while the expected order is still BEING_PROCESSED', async () => {
    const { svc, taskRepo, store, kernel, transportTask, emitter } = setup();
    taskRepo.find.mockResolvedValue([
      task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
      }),
    ]);
    store.get.mockReturnValue({ transportOrder: null });
    kernel.getTransportOrderState.mockResolvedValue('BEING_PROCESSED');

    await svc.run();

    expect(emitter.emit).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('skips a task with no recorded order for its leg', async () => {
    const { svc, taskRepo, kernel, emitter } = setup();
    taskRepo.find.mockResolvedValue([
      task(TaskStatus.PICKING_UP, { assignedVehicleName: 'V1' }), // no pickupOrderName
    ]);

    await svc.run();

    expect(kernel.getTransportOrderState).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('isolates a failing task so others still reconcile', async () => {
    const { svc, taskRepo, store, kernel, emitter } = setup();
    taskRepo.find.mockResolvedValue([
      task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-boom',
      }),
      task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V2',
        pickupOrderName: 'PICKUP-2',
      }),
    ]);
    store.get.mockReturnValue({ transportOrder: null });
    kernel.getTransportOrderState
      .mockRejectedValueOnce(new Error('kernel down'))
      .mockResolvedValueOnce('FINISHED');

    await svc.run();

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(
      FMS_EVENTS.TRANSPORT_ORDER_FINISHED,
      expect.objectContaining({ orderName: 'PICKUP-2' }),
    );
  });
});
