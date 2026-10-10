import { KernelApiService } from '../opentcs/kernel-api.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { TaskTerminationService } from './task-termination.service';
import { TransportTaskService } from './transport-task.service';
import {
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';

const task = (
  status: TaskStatus,
  metadata: TransportTaskEntity['metadata'] = {},
): TransportTaskEntity =>
  ({ id: 'task-1', cargoId: 'c-1', status, metadata }) as TransportTaskEntity;

function setup(orderOnVehicle: string | null = null) {
  const kernelApi = {
    withdrawTransportOrder: jest.fn().mockResolvedValue(undefined),
  };
  const vehicleStore = {
    get: jest.fn().mockReturnValue({ transportOrder: orderOnVehicle }),
  };
  const transportTask = {
    changeStatus: jest
      .fn()
      .mockImplementation((entity: TransportTaskEntity, to: TaskStatus) =>
        Promise.resolve({ ...entity, status: to }),
      ),
  };

  const svc = new TaskTerminationService(
    new TransportOrderService(kernelApi as unknown as KernelApiService),
    vehicleStore as unknown as VehicleStateStore,
    transportTask as unknown as TransportTaskService,
    { activeOrderNames: jest.fn().mockResolvedValue([]) } as never,
  );

  return { svc, kernelApi, transportTask };
}

const withdrawn = (kernelApi: { withdrawTransportOrder: jest.Mock }) =>
  kernelApi.withdrawTransportOrder.mock.calls.map((call) => call[0] as string);

describe('TaskTerminationService', () => {
  it('fails a task that was never assigned to a vehicle', async () => {
    const { svc, kernelApi, transportTask } = setup();

    await svc.terminate(task(TaskStatus.CREATED), TaskStatus.FAILED, {
      trigger: 'API',
    });

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.CREATED }),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );
  });

  it('withdraws the pickup order of a task on its way to the source', async () => {
    const { svc, kernelApi } = setup('PICKUP-1');

    await svc.terminate(
      task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
      }),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );

    expect(withdrawn(kernelApi)).toEqual(['PICKUP-1']);
  });

  it('withdraws only the leg that is still running', async () => {
    const { svc, kernelApi } = setup('DROPOFF-1');

    await svc.terminate(
      task(TaskStatus.DELIVERING, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
        approachOrderName: 'APPROACH-1',
        dropoffOrderName: 'DROPOFF-1',
      }),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );

    expect(withdrawn(kernelApi)).toEqual(['DROPOFF-1']);
  });

  it('withdraws the approach order of a task still waiting for a free lane', async () => {
    const { svc, kernelApi } = setup('APPROACH-1');

    await svc.terminate(
      task(TaskStatus.DELIVERING, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
        approachOrderName: 'APPROACH-1',
      }),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );

    expect(withdrawn(kernelApi)).toEqual(['APPROACH-1']);
  });

  it('withdraws the order the kernel reports when the task metadata lags behind', async () => {
    const { svc, kernelApi } = setup('DROPOFF-1');

    await svc.terminate(
      task(TaskStatus.DELIVERING, {
        assignedVehicleName: 'V1',
        approachOrderName: 'APPROACH-1',
      }),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );

    expect(withdrawn(kernelApi)).toEqual(['DROPOFF-1', 'APPROACH-1']);
  });

  it('ignores whatever the vehicle drives once the task is no longer live', async () => {
    const { svc, kernelApi } = setup('PARK-V1-P-9-uuid');

    await svc.terminate(
      task(TaskStatus.BLOCKED, { assignedVehicleName: 'V1' }),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
  });

  it('fails closed instead of failing the task when the withdrawal blows up', async () => {
    const { svc, kernelApi, transportTask } = setup('PICKUP-1');
    kernelApi.withdrawTransportOrder.mockRejectedValue(
      new Error('kernel down'),
    );

    await expect(
      svc.terminate(
        task(TaskStatus.PICKING_UP, {
          assignedVehicleName: 'V1',
          pickupOrderName: 'PICKUP-1',
        }),
        TaskStatus.FAILED,
        { trigger: 'API' },
      ),
    ).rejects.toThrow();

    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('still fails the task when the withdrawal target is already gone (404)', async () => {
    const { svc, kernelApi, transportTask } = setup('PICKUP-1');
    const notFound = Object.assign(new Error('gone'), {
      response: { status: 404 },
    });
    kernelApi.withdrawTransportOrder.mockRejectedValue(notFound);

    await svc.terminate(
      task(TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
        pickupOrderName: 'PICKUP-1',
      }),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );

    expect(transportTask.changeStatus).toHaveBeenCalled();
  });

  it('leaves a task that already reached a terminal status alone', async () => {
    const { svc, transportTask } = setup();

    await svc.terminate(
      task(TaskStatus.DELIVERY_COMPLETED),
      TaskStatus.FAILED,
      { trigger: 'API' },
    );

    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('cancels instead of failing when the caller asks for it', async () => {
    const { svc, transportTask } = setup();

    await svc.terminate(
      task(TaskStatus.READY_TO_ASSIGN),
      TaskStatus.CANCELLED,
      { trigger: 'API', reason: 'cancelled by operator' },
    );

    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      expect.anything(),
      TaskStatus.CANCELLED,
      { trigger: 'API', reason: 'cancelled by operator' },
    );
  });
});
