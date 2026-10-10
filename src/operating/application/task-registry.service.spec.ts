import { NotFoundException } from '@nestjs/common';
import { TaskRegistryService } from './task-registry.service';
import { TaskStatus } from '../../cargo/entities/transport-task.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../../maps/infrastructure/active-map-context.testing';

const OTHER_MAP = 'map-other';

function taskOn(mapRecordId: string | null) {
  return {
    id: 'task-1',
    requestCode: 'TR-1',
    cargoId: null,
    mapRecordId,
    status: TaskStatus.READY_TO_ASSIGN,
    metadata: {},
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-09-23T01:00:00Z'),
    updatedAt: new Date('2026-09-23T01:00:00Z'),
  };
}

function setup(task = taskOn(OTHER_MAP)) {
  const builder = {
    leftJoin: jest.fn().mockReturnThis(),
    withDeleted: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[task], 1]),
  };
  const taskRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(builder),
    findOne: jest.fn().mockResolvedValue(task),
  };
  const mapRepo = {
    find: jest.fn().mockResolvedValue([{ id: OTHER_MAP, name: 'Kho B' }]),
  };
  const transitionRepo = {
    find: jest.fn().mockResolvedValue([
      {
        fromStatus: 'CREATED',
        toStatus: 'READY_TO_ASSIGN',
        trigger: 'RELEASE_ENGINE',
        vehicleName: null,
        reason: null,
        occurredAt: new Date('2026-09-23T01:00:01Z'),
      },
    ]),
  };
  const views = {
    assemble: jest.fn((tasks: Array<{ id: string }>) =>
      Promise.resolve(tasks.map((t) => ({ taskId: t.id }))),
    ),
  };
  const service = new TaskRegistryService(
    taskRepo as never,
    { findOne: jest.fn() } as never,
    mapRepo as never,
    transitionRepo as never,
    views as never,
    { ordersOf: jest.fn().mockResolvedValue([]) } as never,
    fixedActiveMap(TEST_MAP_ID),
  );
  return { service, builder, taskRepo };
}

describe('TaskRegistryService', () => {
  it('lists tasks of every map with their map name and loaded-map flag', async () => {
    const { service } = setup();

    const list = await service.list({}, undefined);

    expect(list).toMatchObject({ total: 1, page: 1, limit: 50 });
    expect(list.tasks[0]).toMatchObject({
      taskId: 'task-1',
      mapRecordId: OTHER_MAP,
      mapName: 'Kho B',
      onLoadedMap: false,
    });
  });

  it('restricts a scoped role to its maps and applies the filters', async () => {
    const { service, builder } = setup();

    await service.list(
      {
        mapRecordId: OTHER_MAP,
        status: [TaskStatus.BLOCKED],
        search: 'V01',
        page: 2,
        limit: 10,
      },
      [OTHER_MAP],
    );

    expect(builder.andWhere).toHaveBeenCalledWith(
      'task.map_record_id IN (:...mapIds)',
      { mapIds: [OTHER_MAP] },
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      'task.status IN (:...statuses)',
      { statuses: [TaskStatus.BLOCKED] },
    );
    expect(builder.offset).toHaveBeenCalledWith(10);
  });

  it('returns nothing to a role scoped to no map at all', async () => {
    const { service, taskRepo } = setup();

    await expect(service.list({}, [])).resolves.toMatchObject({ total: 0 });
    expect(taskRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns the detail with its status history', async () => {
    const { service } = setup();

    const detail = await service.detail('task-1', undefined);

    expect(detail.transitions).toEqual([
      expect.objectContaining({
        toStatus: 'READY_TO_ASSIGN',
        occurredAt: '2026-09-23T01:00:01.000Z',
      }),
    ]);
  });

  it('hides a task outside the caller’s map scope', async () => {
    const { service } = setup();

    await expect(service.detail('task-1', [TEST_MAP_ID])).rejects.toThrow(
      NotFoundException,
    );
  });
});
