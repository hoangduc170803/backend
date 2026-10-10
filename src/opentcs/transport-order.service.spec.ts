import { TransportOrderService } from './transport-order.service';
import { ORDER_KIND } from './domain/transport-order';
import { TASK_ORDER_EVENTS } from '../cargo/domain/events';

function makeService() {
  const kernelApi = {
    createTransportOrder: jest.fn().mockResolvedValue(undefined),
    withdrawTransportOrder: jest.fn().mockResolvedValue(undefined),
    getTransportOrderStateStrict: jest.fn(),
  };
  const events = { emitAsync: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new TransportOrderService(kernelApi as never, events as never),
    kernelApi,
    events,
  };
}

const conflict = () =>
  Object.assign(new Error('conflict'), { response: { status: 409 } });
const notFound = () =>
  Object.assign(new Error('gone'), { response: { status: 404 } });

function emittedEvents(events: { emitAsync: jest.Mock }): unknown[] {
  return events.emitAsync.mock.calls.map(([name]: unknown[]) => name);
}

describe('TransportOrderService.issue', () => {
  it('names the order after the kind, the vehicle and where it is aimed', async () => {
    const { service, kernelApi } = makeService();

    const orderName = await service.issue({
      kind: ORDER_KIND.PICKUP,
      vehicleName: 'V1',
      aimedAt: 'LOC-1',
      destinations: [{ locationName: 'LOC-1', operation: 'PICK_UP' }],
      taskId: 'task-1',
    });

    expect(orderName).toMatch(/^PICKUP-V1-LOC-1-/);
    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      orderName,
      [{ locationName: 'LOC-1', operation: 'PICK_UP' }],
      'V1',
      { 'wes:taskId': 'task-1', 'wes:leg': 'PICKUP' },
      { dispensable: false },
    );
  });

  it('gives every order its own name, so a retry cannot collide with the order it replaces', async () => {
    const { service } = makeService();
    const order = {
      kind: ORDER_KIND.DROPOFF,
      vehicleName: 'V1',
      aimedAt: 'SLOT-1',
      destinations: [{ locationName: 'SLOT-1', operation: 'DROP_OFF' }],
      taskId: 'task-1',
    } as const;

    expect(await service.issue(order)).not.toBe(await service.issue(order));
  });

  it('stamps the leg from the kind, so a caller cannot mislabel the order', async () => {
    const { service, kernelApi } = makeService();

    await service.issue({
      kind: ORDER_KIND.APPROACH,
      vehicleName: 'V1',
      aimedAt: '0086',
      destinations: [{ locationName: '0086', operation: 'MOVE' }],
      taskId: 'task-1',
    });

    expect(kernelApi.createTransportOrder.mock.calls[0][3]).toEqual({
      'wes:taskId': 'task-1',
      'wes:leg': 'APPROACH',
    });
  });

  it('leaves the task id off a fleet order that belongs to no task', async () => {
    const { service, kernelApi } = makeService();

    await service.issue({
      kind: ORDER_KIND.PARK,
      vehicleName: 'V1',
      aimedAt: '1002',
      destinations: [{ locationName: '1002', operation: 'MOVE' }],
      dispensable: true,
    });

    expect(kernelApi.createTransportOrder.mock.calls[0][3]).toEqual({
      'wes:leg': 'PARK',
    });
  });

  it('marks a park order dispensable so the kernel may drop it for real work', async () => {
    const { service, kernelApi } = makeService();

    await service.issue({
      kind: ORDER_KIND.PARK,
      vehicleName: 'V1',
      aimedAt: '1002',
      destinations: [{ locationName: '1002', operation: 'MOVE' }],
      dispensable: true,
    });

    expect(kernelApi.createTransportOrder.mock.calls[0][4]).toEqual({
      dispensable: true,
    });
  });

  it('keeps the aimed-at name independent of the first destination, because a retreat leg can outlive the drop', async () => {
    const { service, kernelApi } = makeService();

    const orderName = await service.issue({
      kind: ORDER_KIND.DROPOFF,
      vehicleName: 'V1',
      aimedAt: 'SLOT-9',
      destinations: [{ locationName: 'RETREAT-2', operation: 'MOVE' }],
      taskId: 'task-1',
    });

    expect(orderName).toMatch(/^DROPOFF-V1-SLOT-9-/);
    expect(kernelApi.createTransportOrder.mock.calls[0][1]).toEqual([
      { locationName: 'RETREAT-2', operation: 'MOVE' },
    ]);
  });

  it('lets the kernel failure reach the caller, which decides what to do with the task', async () => {
    const { service, kernelApi } = makeService();
    kernelApi.createTransportOrder.mockRejectedValueOnce(new Error('boom'));

    await expect(
      service.issue({
        kind: ORDER_KIND.PICKUP,
        vehicleName: 'V1',
        aimedAt: 'LOC-1',
        destinations: [{ locationName: 'LOC-1', operation: 'PICK_UP' }],
        taskId: 'task-1',
      }),
    ).rejects.toThrow('boom');
  });
});

describe('TransportOrderService.issue with idempotencyKey', () => {
  const pickup = {
    kind: ORDER_KIND.PICKUP,
    vehicleName: 'V1',
    aimedAt: 'LOC-1',
    destinations: [{ locationName: 'LOC-1', operation: 'PICK_UP' }],
    taskId: 'task-1',
    idempotencyKey: 'task-1',
  } as const;

  it('always names the order the same way for the same key, unlike a random retry', async () => {
    const { service } = makeService();

    expect(await service.issue(pickup)).toBe(await service.issue(pickup));
  });

  it('treats a name conflict as already-done when the existing order is still in flight', async () => {
    const { service, kernelApi } = makeService();
    kernelApi.createTransportOrder.mockRejectedValueOnce(conflict());
    kernelApi.getTransportOrderStateStrict.mockResolvedValue('BEING_PROCESSED');

    const orderName = await service.issue(pickup);

    expect(orderName).toMatch(/^PICKUP-V1-LOC-1-/);
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
  });

  it('mints a fresh name instead of resurrecting a conflicting order that already finished', async () => {
    const { service, kernelApi } = makeService();
    let firstAttemptName = '';
    kernelApi.createTransportOrder.mockImplementationOnce((name: string) => {
      firstAttemptName = name;
      return Promise.reject(conflict());
    });
    kernelApi.createTransportOrder.mockResolvedValueOnce(undefined);
    kernelApi.getTransportOrderStateStrict.mockResolvedValue('FINISHED');

    const orderName = await service.issue(pickup);

    expect(orderName).not.toBe(firstAttemptName);
    expect(orderName).toMatch(/^PICKUP-V1-LOC-1-/);
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(2);
  });

  it('mints a fresh name when the conflicting order is already gone (404 on lookup)', async () => {
    const { service, kernelApi } = makeService();
    kernelApi.createTransportOrder.mockRejectedValueOnce(conflict());
    kernelApi.getTransportOrderStateStrict.mockResolvedValue(null);

    const orderName = await service.issue(pickup);

    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(2);
    expect(orderName).toMatch(/^PICKUP-V1-LOC-1-/);
  });

  it('fails closed when it cannot even ask the kernel about the conflicting order', async () => {
    const { service, kernelApi } = makeService();
    kernelApi.createTransportOrder.mockRejectedValueOnce(conflict());
    kernelApi.getTransportOrderStateStrict.mockRejectedValue(
      new Error('kernel down'),
    );

    await expect(service.issue(pickup)).rejects.toThrow('kernel down');
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
  });

  it('does not retry-with-fresh-name for a non-409 failure', async () => {
    const { service, kernelApi } = makeService();
    kernelApi.createTransportOrder.mockRejectedValueOnce(notFound());

    await expect(service.issue(pickup)).rejects.toThrow();
    expect(kernelApi.getTransportOrderStateStrict).not.toHaveBeenCalled();
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
  });
});

describe('TransportOrderService.cancel', () => {
  it('withdraws without pre-empting the vehicle by default', async () => {
    const { service, kernelApi } = makeService();

    await service.cancel('PICKUP-V1-LOC-1');

    expect(kernelApi.withdrawTransportOrder).toHaveBeenCalledWith(
      'PICKUP-V1-LOC-1',
      false,
    );
  });

  it('withdraws immediately when the caller asks for it', async () => {
    const { service, kernelApi } = makeService();

    await service.cancel('PICKUP-V1-LOC-1', { immediate: true });

    expect(kernelApi.withdrawTransportOrder).toHaveBeenCalledWith(
      'PICKUP-V1-LOC-1',
      true,
    );
  });

  it('lets the kernel failure reach the caller and takes the withdrawal mark back', async () => {
    const { service, kernelApi, events } = makeService();
    kernelApi.withdrawTransportOrder.mockRejectedValueOnce(new Error('boom'));

    await expect(service.cancel('PICKUP-V1-LOC-1')).rejects.toThrow('boom');

    expect(emittedEvents(events)).toEqual([
      TASK_ORDER_EVENTS.WITHDRAWING,
      TASK_ORDER_EVENTS.WITHDRAW_REFUSED,
    ]);
  });

  it('treats an already-gone order (404) as nothing left to withdraw, not a failure', async () => {
    const { service, kernelApi, events } = makeService();
    kernelApi.withdrawTransportOrder.mockRejectedValueOnce(notFound());

    await expect(service.cancel('PICKUP-V1-LOC-1')).resolves.toBeUndefined();

    expect(emittedEvents(events)).toEqual([
      TASK_ORDER_EVENTS.WITHDRAWING,
      TASK_ORDER_EVENTS.WITHDRAWN,
    ]);
    expect(events.emitAsync).toHaveBeenLastCalledWith(
      TASK_ORDER_EVENTS.WITHDRAWN,
      expect.objectContaining({ orderName: 'PICKUP-V1-LOC-1' }),
    );
  });

  it('marks the order as being withdrawn before asking the kernel, and withdrawn only once it accepted', async () => {
    const { service, kernelApi, events } = makeService();

    await service.cancel('PICKUP-V1-LOC-1');

    const [markedAt, settledAt] = events.emitAsync.mock.invocationCallOrder;
    const askedAt =
      kernelApi.withdrawTransportOrder.mock.invocationCallOrder[0];
    expect(emittedEvents(events)).toEqual([
      TASK_ORDER_EVENTS.WITHDRAWING,
      TASK_ORDER_EVENTS.WITHDRAWN,
    ]);
    expect(markedAt).toBeLessThan(askedAt);
    expect(askedAt).toBeLessThan(settledAt);
  });
});
