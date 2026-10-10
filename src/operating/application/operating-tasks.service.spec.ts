import { OperatingTasksService } from './operating-tasks.service';
import { TaskViewAssembler } from './task-view.assembler';
import { TaskStatus } from '../../cargo/entities/transport-task.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../../maps/infrastructure/active-map-context.testing';

function makeService(activeMapId: string | null = TEST_MAP_ID) {
  const tasks = [
    {
      id: 'task-1',
      requestCode: 'TR-1',
      cargoId: 'cargo-1',
      mapRecordId: TEST_MAP_ID,
      status: TaskStatus.FAILED,
      metadata: {},
      assignedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: new Date('2026-09-23T01:00:00Z'),
      updatedAt: new Date('2026-09-23T01:00:00Z'),
    },
  ];
  const builder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest
      .fn()
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValue([tasks, 3]),
  };
  const taskRepo = { createQueryBuilder: jest.fn().mockReturnValue(builder) };
  const cargoRepo = {
    find: jest
      .fn()
      .mockResolvedValue([
        { id: 'cargo-1', itemCode: 'BOX-1', destinationZoneId: 'zone-1' },
      ]),
  };
  const zoneRepo = {
    find: jest.fn().mockResolvedValue([{ id: 'zone-1', name: 'Khu A' }]),
  };
  const transitionRepo = {
    find: jest.fn().mockResolvedValue([
      { taskId: 'task-1', reason: 'cargo deleted' },
      { taskId: 'task-1', reason: 'older reason' },
    ]),
  };
  const service = new OperatingTasksService(
    taskRepo as never,
    new TaskViewAssembler(
      cargoRepo as never,
      zoneRepo as never,
      transitionRepo as never,
      { ordersOf: jest.fn().mockResolvedValue([]) } as never,
    ),
    fixedActiveMap(activeMapId),
    { namesOf: jest.fn().mockResolvedValue(new Map()) } as never,
  );
  return { service, taskRepo, builder };
}

describe('OperatingTasksService', () => {
  it('lists the loaded map’s tasks joined with cargo, zone and failure reason', async () => {
    const { service, builder } = makeService();

    const list = await service.list({}, undefined);

    expect(builder.where).toHaveBeenCalledWith(
      'task.map_record_id IN (:...mapIds)',
      { mapIds: [TEST_MAP_ID] },
    );
    expect(list.total).toBe(3);
    expect(list.truncated).toBe(true);
    expect(list.tasks[0]).toMatchObject({
      taskId: 'task-1',
      itemCode: 'BOX-1',
      destinationZoneName: 'Khu A',
      failureReason: 'cargo deleted',
    });
  });

  it('returns nothing while the loaded map is unknown', async () => {
    const { service, taskRepo } = makeService(null);

    await expect(service.list({}, undefined)).resolves.toEqual({
      tasks: [],
      total: 0,
      truncated: false,
    });
    expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns nothing to a role not scoped to the loaded map', async () => {
    const { service, taskRepo } = makeService();

    const list = await service.list({}, ['some-other-map']);

    expect(list.tasks).toEqual([]);
    expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('lists for a role scoped to the loaded map', async () => {
    const { service } = makeService();

    const list = await service.list({}, [TEST_MAP_ID]);

    expect(list.tasks).toHaveLength(1);
  });

  it('reads every map for scope=all without narrowing the query to one map', async () => {
    const { service, builder } = makeService();

    const list = await service.list({ scope: 'all' }, undefined);

    expect(list.tasks).toHaveLength(1);
    expect(builder.where).not.toHaveBeenCalledWith(
      'task.map_record_id IN (:...mapIds)',
      expect.anything(),
    );
    expect(list.tasks[0].onLoadedMap).toBe(true);
  });
});
