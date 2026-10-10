import {
  ApproachOrderService,
  approachTargetFor,
} from './approach-order.service';
import { TransportOrderService } from '../opentcs/transport-order.service';

const SLOT = 'location_0521';
const WAIT_POINT = '0549';

function makeService() {
  const taskRepo = { save: jest.fn().mockResolvedValue(undefined) };
  const kernelApi = {
    createTransportOrder: jest.fn().mockResolvedValue(undefined),
    withdrawTransportOrder: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ApproachOrderService(
    taskRepo as never,
    new TransportOrderService(kernelApi as never),
    { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
  );
  return { service, taskRepo, kernelApi };
}

function task(metadata: Record<string, unknown> = {}) {
  return { id: 'task-1', metadata } as never;
}

describe('ApproachOrderService.aim', () => {
  it('uses NOP for a slot, because a location destination rejects MOVE', async () => {
    const { service, kernelApi } = makeService();

    await service.aim(task(), 'V1', { locationName: SLOT });

    const [orderName, destinations, vehicle, properties] =
      kernelApi.createTransportOrder.mock.calls[0];
    expect(destinations).toEqual([{ locationName: SLOT, operation: 'NOP' }]);
    expect(orderName).toMatch(/^APPROACH-V1-/);
    expect(vehicle).toBe('V1');
    expect(properties).toEqual({
      'wes:taskId': 'task-1',
      'wes:leg': 'APPROACH',
    });
  });

  it('records where the vehicle is headed and clears the arrival mark', async () => {
    const { service, taskRepo } = makeService();

    await service.aim(
      task({ approachedAt: '2026-08-18T00:00:00.000Z' }),
      'V1',
      { locationName: SLOT },
    );

    const saved = taskRepo.save.mock.calls[0][0] as {
      metadata: Record<string, string | undefined>;
    };
    expect(saved.metadata.approachPointName).toBe(SLOT);
    expect(saved.metadata.approachOrderName).toMatch(/^APPROACH-V1-/);
    expect(saved.metadata.approachedAt).toBeUndefined();
  });

  it('does nothing when the vehicle is already aimed there', async () => {
    const { service, kernelApi, taskRepo } = makeService();

    const result = await service.aim(
      task({ approachPointName: SLOT, approachOrderName: 'APPROACH-V1-old' }),
      'V1',
      { locationName: SLOT },
    );

    expect(result).toBe('APPROACH-V1-old');
    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it('withdraws the order in flight before aiming somewhere else', async () => {
    const { service, kernelApi } = makeService();

    await service.aim(
      task({ approachPointName: SLOT, approachOrderName: 'APPROACH-V1-old' }),
      'V1',
      { pointName: WAIT_POINT },
    );

    expect(kernelApi.withdrawTransportOrder).toHaveBeenCalledWith(
      'APPROACH-V1-old',
      false,
    );
    expect(kernelApi.createTransportOrder).toHaveBeenCalled();
  });

  it('leaves the vehicle on its old order when the withdrawal fails', async () => {
    const { service, kernelApi } = makeService();
    kernelApi.withdrawTransportOrder.mockRejectedValueOnce(new Error('boom'));

    const result = await service.aim(
      task({ approachPointName: SLOT, approachOrderName: 'APPROACH-V1-old' }),
      'V1',
      { pointName: WAIT_POINT },
    );

    expect(result).toBeNull();
    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('uses MOVE for a waiting point, because a point destination rejects NOP', async () => {
    const { service, kernelApi } = makeService();

    await service.aim(task(), 'V1', { pointName: WAIT_POINT });

    const [, destinations] = kernelApi.createTransportOrder.mock.calls[0];
    expect(destinations).toEqual([
      { locationName: WAIT_POINT, operation: 'MOVE' },
    ]);
  });

  it('reports failure when the kernel refuses the order', async () => {
    const { service, kernelApi, taskRepo } = makeService();
    kernelApi.createTransportOrder.mockRejectedValueOnce(new Error('nope'));

    expect(await service.aim(task(), 'V1', { locationName: SLOT })).toBeNull();
    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it('drops the withdrawn order reference when the replacement cannot be created', async () => {
    const { service, kernelApi, taskRepo } = makeService();
    kernelApi.createTransportOrder.mockRejectedValueOnce(new Error('nope'));

    const result = await service.aim(
      task({ approachPointName: SLOT, approachOrderName: 'APPROACH-V1-old' }),
      'V1',
      { pointName: WAIT_POINT },
    );

    expect(result).toBeNull();
    const saved = taskRepo.save.mock.calls[0][0] as {
      metadata: Record<string, string | undefined>;
    };
    expect(saved.metadata.approachOrderName).toBeUndefined();
    expect(saved.metadata.approachPointName).toBeUndefined();
  });
});

describe('approachTargetFor', () => {
  const layout = {
    lanes: [
      {
        axis: 0,
        slots: [{ locationName: SLOT, pointName: '0521' }],
        axisPoints: ['0521', WAIT_POINT],
      },
    ],
  } as never;

  it('sends a drop-off slot as a location, so it goes out as NOP', () => {
    expect(approachTargetFor(layout, SLOT)).toEqual({ locationName: SLOT });
  });

  it('sends a waiting point as a point, so it goes out as MOVE', () => {
    expect(approachTargetFor(layout, WAIT_POINT)).toEqual({
      pointName: WAIT_POINT,
    });
  });
});
