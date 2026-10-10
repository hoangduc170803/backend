import { kernelSessionStub } from '../kernel-session/kernel-session.testing';
import { DirectTaskService } from './direct-task.service';
import { TaskKind, TaskStatus } from './entities/transport-task.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../maps/infrastructure/active-map-context.testing';

function setup(activeMapId: string | null = TEST_MAP_ID, kernelReady = true) {
  const taskRepo = {
    create: jest.fn((value: object) => value),
    save: jest.fn((value: object) =>
      Promise.resolve({ id: 'task-1', ...value }),
    ),
  };
  const transportOrders = {
    issue: jest.fn().mockResolvedValue('PARK-V1-P7-x'),
  };
  const transportTask = {
    publishCreated: jest.fn(),
    changeStatus: jest.fn().mockResolvedValue(undefined),
  };
  const parkYield = { yieldVehicle: jest.fn().mockResolvedValue(undefined) };
  const service = new DirectTaskService(
    taskRepo as never,
    transportOrders as never,
    transportTask as never,
    fixedActiveMap(activeMapId),
    parkYield as never,
    { assertCanTakeNewWork: jest.fn().mockResolvedValue(undefined) } as never,
    kernelSessionStub({ ready: kernelReady }),
  );
  return { service, taskRepo, transportOrders, transportTask, parkYield };
}

const PARK = {
  kind: TaskKind.PARK,
  vehicleName: 'V1',
  aimedAt: 'P7',
  destinations: [{ locationName: 'P7', operation: 'MOVE' }],
  dispensable: true,
  trigger: 'PARKING_ENGINE',
} as const;

describe('DirectTaskService', () => {
  it('creates the task assigned to the vehicle, then issues its order under the task id', async () => {
    const { service, taskRepo, transportOrders, transportTask } = setup();

    const created = await service.create(PARK);

    expect(taskRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: TaskKind.PARK,
        status: TaskStatus.CREATED,
        mapRecordId: TEST_MAP_ID,
        metadata: { assignedVehicleName: 'V1' },
        requestCode: expect.stringMatching(/^PK-/),
      }),
    );
    expect(transportTask.publishCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      'PARKING_ENGINE',
    );
    expect(transportOrders.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'PARK',
        vehicleName: 'V1',
        taskId: 'task-1',
        dispensable: true,
      }),
    );
    expect(created.orderName).toBe('PARK-V1-P7-x');
  });

  it('lets the kernel pick the vehicle when none is given', async () => {
    const { service, taskRepo, transportOrders } = setup();

    await service.create({
      ...PARK,
      kind: TaskKind.MANUAL,
      vehicleName: null,
      trigger: 'API',
    });

    expect(taskRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: {}, assignedAt: null }),
    );
    expect(transportOrders.issue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'MANUAL', vehicleName: null }),
    );
  });

  it('fails the task when its order cannot be issued', async () => {
    const { service, transportOrders, transportTask } = setup();
    transportOrders.issue.mockRejectedValueOnce(new Error('kernel down'));

    await expect(service.create(PARK)).rejects.toThrow('kernel down');

    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      TaskStatus.FAILED,
      expect.objectContaining({
        reason: expect.stringContaining('kernel down'),
      }),
    );
  });

  it('clears the park task of the chosen vehicle before issuing a manual order', async () => {
    const { service, transportOrders, parkYield } = setup();

    await service.create({ ...PARK, kind: TaskKind.MANUAL, trigger: 'API' });

    expect(parkYield.yieldVehicle).toHaveBeenCalledWith('V1', TEST_MAP_ID);
    expect(parkYield.yieldVehicle.mock.invocationCallOrder[0]).toBeLessThan(
      transportOrders.issue.mock.invocationCallOrder[0],
    );
  });

  it('never yields for a park order or when the kernel picks the vehicle', async () => {
    const { service, parkYield } = setup();

    await service.create(PARK);
    await service.create({
      ...PARK,
      kind: TaskKind.MANUAL,
      vehicleName: null,
      trigger: 'API',
    });

    expect(parkYield.yieldVehicle).not.toHaveBeenCalled();
  });

  it('queues the order while the kernel is being restored instead of failing the task', async () => {
    const { service, taskRepo, transportOrders, transportTask, parkYield } =
      setup(TEST_MAP_ID, false);

    const created = await service.create({ ...PARK, kind: TaskKind.MANUAL });

    expect(created.orderName).toBeNull();
    expect(transportOrders.issue).not.toHaveBeenCalled();
    expect(parkYield.yieldVehicle).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
    const saved = taskRepo.save.mock.calls.at(-1)?.[0] as {
      status: TaskStatus;
      metadata: { pendingOrder?: { aimedAt: string } };
    };
    expect(saved.status).toBe(TaskStatus.CREATED);
    expect(saved.metadata.pendingOrder?.aimedAt).toBe('P7');
  });

  it('issues a queued order once the kernel is back and forgets it', async () => {
    const { service, taskRepo, transportOrders, parkYield } = setup();
    const queued = {
      id: 'task-9',
      kind: TaskKind.MANUAL,
      mapRecordId: TEST_MAP_ID,
      metadata: {
        assignedVehicleName: 'V1',
        pendingOrder: {
          kind: 'MANUAL',
          vehicleName: 'V1',
          aimedAt: 'P7',
          destinations: [{ locationName: 'P7', operation: 'MOVE' }],
        },
      },
    };

    await expect(service.issuePending(queued as never)).resolves.toBe(
      'PARK-V1-P7-x',
    );

    expect(parkYield.yieldVehicle).toHaveBeenCalledWith('V1', TEST_MAP_ID);
    expect(transportOrders.issue).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-9', aimedAt: 'P7' }),
    );
    expect(taskRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { assignedVehicleName: 'V1' } }),
    );
  });

  it('refuses when the loaded map is unknown', async () => {
    const { service, taskRepo } = setup(null);

    await expect(service.create(PARK)).rejects.toThrow('bản đồ đang tải');
    expect(taskRepo.save).not.toHaveBeenCalled();
  });
});
