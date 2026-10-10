import { TaskCancellationService } from './task-cancellation.service';
import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../maps/infrastructure/active-map-context.testing';

const ALL = { cargo: true, direct: true };

function task(
  status: TaskStatus,
  kind: TaskKind,
  overrides: Partial<TransportTaskEntity> = {},
): TransportTaskEntity {
  return {
    id: 't1',
    requestCode: 'TR-1',
    kind,
    status,
    cargoId: kind === TaskKind.CARGO ? 'c1' : null,
    mapRecordId: TEST_MAP_ID,
    metadata: { assignedVehicleName: 'V1' },
    ...overrides,
  } as TransportTaskEntity;
}

function setup(found: TransportTaskEntity | null) {
  const builder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(found),
  };
  const taskRepo = {
    findOne: jest.fn().mockResolvedValue(found),
    find: jest.fn().mockResolvedValue(found ? [found] : []),
    create: jest.fn((value: object) => value),
    save: jest.fn((value: object) => Promise.resolve({ id: 't2', ...value })),
    createQueryBuilder: jest.fn().mockReturnValue(builder),
  };
  const cargoRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'c1', itemCode: 'BOX-1' }),
  };
  const taskTermination = { terminate: jest.fn().mockResolvedValue(undefined) };
  const transportTask = {
    publishCreated: jest.fn(),
    publishUpdated: jest.fn(),
  };
  const loadHandling = {
    assertVehicleIsNotHandlingTheLoad: jest.fn().mockResolvedValue(undefined),
  };
  const kernelApi = {
    withdrawVehicleOrder: jest.fn().mockResolvedValue(undefined),
  };
  const vehicleStore = {
    get: jest.fn().mockReturnValue({ transportOrder: 'MOVE-1' }),
  };
  const service = new TaskCancellationService(
    taskRepo as never,
    cargoRepo as never,
    taskTermination as never,
    transportTask as never,
    loadHandling as never,
    fixedActiveMap(),
    kernelApi as never,
    vehicleStore as never,
  );
  return {
    service,
    taskRepo,
    taskTermination,
    transportTask,
    loadHandling,
    kernelApi,
  };
}

describe('TaskCancellationService', () => {
  it('refuses a cargo task whose load is already on the vehicle', async () => {
    const { service, taskTermination } = setup(
      task(TaskStatus.DELIVERING, TaskKind.CARGO),
    );

    const { results } = await service.cancelTasks(['t1'], { permissions: ALL });

    expect(results[0]).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('Hàng đã lên xe'),
    });
    expect(taskTermination.terminate).not.toHaveBeenCalled();
  });

  it('cancels a cargo task before pickup and requeues the cargo as a new task', async () => {
    const { service, taskTermination, taskRepo, transportTask, loadHandling } =
      setup(task(TaskStatus.PICKING_UP, TaskKind.CARGO));

    const { results } = await service.cancelTasks(['t1'], { permissions: ALL });

    expect(loadHandling.assertVehicleIsNotHandlingTheLoad).toHaveBeenCalled();
    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      TaskStatus.CANCELLED,
      expect.anything(),
      { onLoadedMap: true },
    );
    expect(taskRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: TaskKind.CARGO,
        cargoId: 'c1',
        status: TaskStatus.CREATED,
        mapRecordId: TEST_MAP_ID,
      }),
    );
    expect(transportTask.publishCreated).toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      outcome: 'cancelled',
      replacementTaskId: 't2',
    });
  });

  it('cancels a non-cargo task and its orders without requeueing', async () => {
    const { service, taskTermination, taskRepo } = setup(
      task(TaskStatus.EXECUTING, TaskKind.MANUAL),
    );

    const { results } = await service.cancelTasks(['t1'], { permissions: ALL });

    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      TaskStatus.CANCELLED,
      expect.anything(),
      { onLoadedMap: true },
    );
    expect(taskRepo.save).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      outcome: 'cancelled',
      replacementTaskId: null,
    });
  });

  it.each([
    [TaskKind.CARGO, { cargo: false, direct: true }, 'cargo.cancel'],
    [TaskKind.PARK, { cargo: true, direct: false }, 'task.cancel'],
  ])(
    'requires the permission of the task kind (%s)',
    async (kind, permissions, key) => {
      const { service, taskTermination } = setup(
        task(TaskStatus.CREATED, kind),
      );

      const { results } = await service.cancelTasks(['t1'], { permissions });

      expect(results[0].reason).toContain(key);
      expect(taskTermination.terminate).not.toHaveBeenCalled();
    },
  );

  it('never looks a vehicle up by name for a task of another map', async () => {
    const { service, taskTermination, loadHandling } = setup(
      task(TaskStatus.PICKING_UP, TaskKind.CARGO, { mapRecordId: 'other' }),
    );

    await service.cancelTasks(['t1'], { permissions: ALL });

    expect(
      loadHandling.assertVehicleIsNotHandlingTheLoad,
    ).not.toHaveBeenCalled();
    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.anything(),
      TaskStatus.CANCELLED,
      expect.anything(),
      { onLoadedMap: false },
    );
  });

  it('reports finished tasks and hides tasks outside the role scope', async () => {
    const finished = setup(task(TaskStatus.COMPLETED, TaskKind.MANUAL));
    const scoped = setup(task(TaskStatus.CREATED, TaskKind.MANUAL));

    const done = await finished.service.cancelTasks(['t1'], {
      permissions: ALL,
    });
    const hidden = await scoped.service.cancelTasks(['t1'], {
      permissions: ALL,
      mapIds: ['another-map'],
    });

    expect(done.results[0]).toMatchObject({
      outcome: 'failed',
      reason: 'Nhiệm vụ đã kết thúc.',
    });
    expect(hidden.results[0]).toMatchObject({
      outcome: 'failed',
      reason: 'Không tìm thấy nhiệm vụ.',
    });
  });

  it('cancels the vehicle task, or withdraws a raw order when the vehicle has no task', async () => {
    const withTask = setup(task(TaskStatus.EXECUTING, TaskKind.MANUAL));
    const withoutTask = setup(null);

    const cancelled = await withTask.service.cancelVehicleWork('V1', {
      permissions: ALL,
    });
    const raw = await withoutTask.service.cancelVehicleWork('V1', {
      permissions: ALL,
    });

    expect(cancelled?.outcome).toBe('cancelled');
    expect(withTask.kernelApi.withdrawVehicleOrder).not.toHaveBeenCalled();
    expect(raw).toBeNull();
    expect(withoutTask.kernelApi.withdrawVehicleOrder).toHaveBeenCalledWith(
      'V1',
      false,
    );
  });

  it('skips the load-handling guard when the load is confirmed off board', async () => {
    const { service, loadHandling, taskTermination } = setup(
      task(TaskStatus.PICKING_UP, TaskKind.CARGO),
    );

    const { results } = await service.cancelTasks(['t1'], {
      permissions: ALL,
      loadConfirmedOffBoard: true,
    });

    expect(
      loadHandling.assertVehicleIsNotHandlingTheLoad,
    ).not.toHaveBeenCalled();
    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.anything(),
      TaskStatus.CANCELLED,
      expect.anything(),
      { onLoadedMap: true },
    );
    expect(results[0].replacementTaskId).toBe('t2');
  });
});
