import { TransportOrderService } from '../opentcs/transport-order.service';
import { DropoffOrderService } from './dropoff-order.service';

const SLOT = 'location_3003';
const ZONE = { id: 'zone-1', name: 'zone_1' } as never;
const PLAN = { cells: ['3002', '3001'], egress: null };

function makeService(plan: unknown = PLAN) {
  const taskRepo = { save: jest.fn().mockResolvedValue(undefined) };
  const kernelApi = {
    unloadOperation: 'liftDown',
    createTransportOrder: jest.fn().mockResolvedValue(undefined),
    withdrawTransportOrder: jest.fn().mockResolvedValue(undefined),
  };
  const retreatPoint = {
    planFor: jest.fn().mockResolvedValue(plan),
  };
  const service = new DropoffOrderService(
    taskRepo as never,
    kernelApi as never,
    new TransportOrderService(kernelApi as never),
    retreatPoint as never,
    { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
  );
  return { service, taskRepo, kernelApi, retreatPoint };
}

function task(metadata: Record<string, unknown> = {}) {
  return { id: 'task-1', metadata } as never;
}

describe('DropoffOrderService.issue', () => {
  it('puts the drop-off first, then one MOVE to the last retreat cell', async () => {
    const { service, kernelApi } = makeService();

    await service.issue(task(), 'V1', SLOT, ZONE);

    const [, destinations] = kernelApi.createTransportOrder.mock.calls[0];
    expect(destinations).toEqual([
      { locationName: SLOT, operation: 'liftDown' },
      { locationName: '3001', operation: 'MOVE' },
    ]);
  });

  it('never aims the vehicle at a turn-off cell, which two lanes could be given at once', async () => {
    const { service, kernelApi } = makeService({
      cells: ['3002', '3001'],
      egress: '0091',
    });

    await service.issue(task(), 'V1', SLOT, ZONE);

    const [, destinations] = kernelApi.createTransportOrder.mock.calls[0];
    expect(
      (destinations as { locationName: string }[]).map((d) => d.locationName),
    ).toEqual([SLOT, '3001']);
  });

  it('keeps the order on the DROPOFF leg and pins the assigned vehicle', async () => {
    const { service, kernelApi } = makeService();

    await service.issue(task(), 'V1', SLOT, ZONE);

    const [orderName, , vehicle, properties] =
      kernelApi.createTransportOrder.mock.calls[0];
    expect(orderName).toMatch(/^DROPOFF-V1-/);
    expect(vehicle).toBe('V1');
    expect(properties).toEqual({
      'wes:taskId': 'task-1',
      'wes:leg': 'DROPOFF',
    });
  });

  it('records the order name and the last retreat cell on the task', async () => {
    const { service, taskRepo } = makeService();

    await service.issue(task(), 'V1', SLOT, ZONE);

    const saved = taskRepo.save.mock.calls[0][0] as {
      metadata: Record<string, string>;
    };
    expect(saved.metadata.dropoffOrderName).toMatch(/^DROPOFF-V1-/);
    expect(saved.metadata.retreatPointName).toBe('3001');
  });

  it('still delivers with a single destination when no retreat path resolves', async () => {
    const { service, kernelApi, taskRepo } = makeService(null);

    await service.issue(task(), 'V1', SLOT, ZONE);

    const [, destinations] = kernelApi.createTransportOrder.mock.calls[0];
    expect(destinations).toEqual([
      { locationName: SLOT, operation: 'liftDown' },
    ]);
    const saved = taskRepo.save.mock.calls[0][0] as {
      metadata: Record<string, string | undefined>;
    };
    expect(saved.metadata.retreatPointName).toBeUndefined();
  });
});

describe('DropoffOrderService.reissue', () => {
  it('withdraws the order in flight before aiming at the new slot', async () => {
    const { service, kernelApi } = makeService();

    await service.reissue(
      task({ dropoffOrderName: 'DROPOFF-V1-old' }),
      'V1',
      SLOT,
      ZONE,
    );

    expect(kernelApi.withdrawTransportOrder).toHaveBeenCalledWith(
      'DROPOFF-V1-old',
      false,
    );
    expect(kernelApi.createTransportOrder).toHaveBeenCalled();
  });

  it('leaves the vehicle on its old order when the withdrawal fails', async () => {
    const { service, kernelApi } = makeService();
    kernelApi.withdrawTransportOrder.mockRejectedValueOnce(new Error('boom'));

    const result = await service.reissue(
      task({ dropoffOrderName: 'DROPOFF-V1-old' }),
      'V1',
      SLOT,
      ZONE,
    );

    expect(result).toBeNull();
    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('issues straight away when nothing is in flight yet', async () => {
    const { service, kernelApi } = makeService();

    await service.reissue(task(), 'V1', SLOT, ZONE);

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(kernelApi.createTransportOrder).toHaveBeenCalled();
  });
});
