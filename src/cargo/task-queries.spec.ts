import { latestTaskByCargoId } from './task-queries';
import {
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';

function task(id: string, cargoId: string | null): TransportTaskEntity {
  return {
    id,
    cargoId,
    status: TaskStatus.CREATED,
  } as TransportTaskEntity;
}

describe('latestTaskByCargoId', () => {
  it('returns an empty map without querying for empty cargo ids', async () => {
    const taskRepo = { find: jest.fn() };

    await expect(latestTaskByCargoId(taskRepo as never, [])).resolves.toEqual(
      new Map(),
    );

    expect(taskRepo.find).not.toHaveBeenCalled();
  });

  it('keeps the newest task for each cargo from the sorted results', async () => {
    const newest = task('newest', 'cargo-1');
    const other = task('other', 'cargo-2');
    const taskRepo = {
      find: jest
        .fn()
        .mockResolvedValue([newest, task('older', 'cargo-1'), other]),
    };

    const result = await latestTaskByCargoId(taskRepo as never, [
      'cargo-1',
      'cargo-2',
    ]);

    expect(result).toEqual(
      new Map([
        ['cargo-1', newest],
        ['cargo-2', other],
      ]),
    );
  });

  it('ignores tasks without a cargo id', async () => {
    const cargoTask = task('cargo-task', 'cargo-1');
    const taskRepo = {
      find: jest.fn().mockResolvedValue([task('direct-task', null), cargoTask]),
    };

    const result = await latestTaskByCargoId(taskRepo as never, ['cargo-1']);

    expect(result).toEqual(new Map([['cargo-1', cargoTask]]));
  });

  it('orders tasks by creation time and id descending', async () => {
    const taskRepo = { find: jest.fn().mockResolvedValue([]) };

    await latestTaskByCargoId(taskRepo as never, ['cargo-1']);

    expect(taskRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { createdAt: 'DESC', id: 'DESC' },
      }),
    );
  });
});
