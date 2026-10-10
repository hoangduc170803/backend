import { DirectTaskSaga } from './direct-task.saga';
import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';
import { TaskOrderEndedEvent, type TaskOrderOutcome } from './domain/events';

function setup(task: Partial<TransportTaskEntity>) {
  const stored = {
    id: 'task-1',
    requestCode: 'MN-1',
    metadata: {},
    ...task,
  } as TransportTaskEntity;
  const taskRepo = {
    findOne: jest.fn().mockResolvedValue(stored),
    save: jest.fn().mockResolvedValue(stored),
  };
  const transportTask = {
    changeStatus: jest.fn().mockResolvedValue(stored),
    publishUpdated: jest.fn(),
  };
  const saga = new DirectTaskSaga(taskRepo as never, transportTask as never);
  return { saga, stored, transportTask };
}

const ended = (outcome: TaskOrderOutcome) =>
  new TaskOrderEndedEvent('task-1', 'O-1', 'MANUAL', outcome, 'V2');

describe('DirectTaskSaga', () => {
  it('starts a task and records the vehicle the kernel picked', async () => {
    const { saga, stored, transportTask } = setup({
      kind: TaskKind.MANUAL,
      status: TaskStatus.CREATED,
    });

    await saga.onTaskOrder(ended('STARTED'));

    expect(stored.metadata.assignedVehicleName).toBe('V2');
    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      stored,
      TaskStatus.EXECUTING,
      expect.objectContaining({ vehicleName: 'V2' }),
    );
  });

  it.each([
    ['FINISHED', TaskStatus.COMPLETED],
    ['FAILED', TaskStatus.FAILED],
    ['PREEMPTED', TaskStatus.CANCELLED],
    ['WITHDRAWN_EXTERNALLY', TaskStatus.CANCELLED],
    ['LOST', TaskStatus.FAILED],
  ] as const)('ends the task on %s', async (outcome, status) => {
    const { saga, transportTask } = setup({
      kind: TaskKind.PARK,
      status: TaskStatus.EXECUTING,
    });

    await saga.onTaskOrder(ended(outcome));

    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      expect.anything(),
      status,
      expect.objectContaining({ trigger: 'SAGA' }),
    );
  });

  it.each(['FAILED', 'WITHDRAWN_EXTERNALLY', 'LOST'] as const)(
    'leaves a %s manual or charge order to be recreated',
    async (outcome) => {
      for (const kind of [TaskKind.MANUAL, TaskKind.CHARGE]) {
        const { saga, transportTask } = setup({
          kind,
          status: TaskStatus.EXECUTING,
        });

        await saga.onTaskOrder(ended(outcome));

        expect(transportTask.changeStatus).not.toHaveBeenCalled();
      }
    },
  );

  it('leaves cargo tasks to the cargo saga', async () => {
    const { saga, transportTask } = setup({
      kind: TaskKind.CARGO,
      status: TaskStatus.PICKING_UP,
    });

    await saga.onTaskOrder(ended('FINISHED'));

    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });
});

describe('DirectTaskSaga ordering', () => {
  it('handles the events of one task one after the other', async () => {
    const stored = {
      id: 'task-1',
      requestCode: 'MN-1',
      kind: TaskKind.MANUAL,
      status: TaskStatus.CREATED,
      metadata: {},
    } as unknown as TransportTaskEntity;
    const taskRepo = {
      findOne: jest.fn(() => Promise.resolve({ ...stored })),
      save: jest.fn().mockResolvedValue(stored),
    };
    const transportTask = {
      changeStatus: jest.fn((task: TransportTaskEntity, to: TaskStatus) => {
        stored.status = to;
        return Promise.resolve(task);
      }),
      publishUpdated: jest.fn(),
    };
    const saga = new DirectTaskSaga(taskRepo as never, transportTask as never);

    await Promise.all([
      saga.onTaskOrder(
        new TaskOrderEndedEvent('task-1', 'O-1', 'MANUAL', 'STARTED', 'V1'),
      ),
      saga.onTaskOrder(
        new TaskOrderEndedEvent('task-1', 'O-1', 'MANUAL', 'STARTED', 'V1'),
      ),
    ]);

    expect(transportTask.changeStatus).toHaveBeenCalledTimes(1);
  });
});
