import { ParkYieldService } from './park-yield.service';
import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from './entities/transport-task.entity';

function parkTask(id: string): TransportTaskEntity {
  return {
    id,
    requestCode: `PK-${id}`,
    kind: TaskKind.PARK,
    status: TaskStatus.EXECUTING,
    metadata: { assignedVehicleName: 'V1' },
  } as TransportTaskEntity;
}

function setup(tasks: TransportTaskEntity[]) {
  const query = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(tasks),
  };
  const taskRepo = { createQueryBuilder: jest.fn().mockReturnValue(query) };
  const taskTermination = { terminate: jest.fn().mockResolvedValue(undefined) };
  const parkClaims = { release: jest.fn() };
  const service = new ParkYieldService(
    taskRepo as never,
    taskTermination as never,
    parkClaims as never,
  );
  return { service, query, taskTermination, parkClaims };
}

describe('ParkYieldService', () => {
  it('cancels every live park task of the vehicle through the regular termination path', async () => {
    const running = parkTask('running');
    const queued = { ...parkTask('queued'), status: TaskStatus.CREATED };
    const { service, taskTermination, parkClaims } = setup([running, queued]);

    await service.yieldVehicle('V1', 'map-1');

    for (const task of [running, queued]) {
      expect(taskTermination.terminate).toHaveBeenCalledWith(
        task,
        TaskStatus.CANCELLED,
        expect.objectContaining({
          trigger: 'ASSIGNMENT_ENGINE',
          reason: 'Nhường xe cho nhiệm vụ khác',
          vehicleName: 'V1',
        }),
      );
      expect(task.cancelledAt).toBeInstanceOf(Date);
      expect(task.metadata.cancelReason).toBe('Nhường xe cho nhiệm vụ khác');
    }
    expect(parkClaims.release).toHaveBeenCalledWith('V1');
  });

  it('only looks at live park tasks of that vehicle on the loaded map', async () => {
    const { service, query } = setup([]);

    await service.yieldVehicle('V1', 'map-1');

    expect(query.where).toHaveBeenCalledWith(
      'task.map_record_id = :mapRecordId',
      { mapRecordId: 'map-1' },
    );
    expect(query.andWhere).toHaveBeenCalledWith('task.kind = :kind', {
      kind: TaskKind.PARK,
    });
    expect(query.andWhere).toHaveBeenCalledWith(
      'task.status IN (:...statuses)',
      { statuses: [TaskStatus.CREATED, TaskStatus.EXECUTING] },
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      `task.metadata->>'assignedVehicleName' = :vehicleName`,
      { vehicleName: 'V1' },
    );
  });

  it('leaves the park claim alone when the vehicle had nothing to yield', async () => {
    const { service, taskTermination, parkClaims } = setup([]);

    await service.yieldVehicle('V1', 'map-1');

    expect(taskTermination.terminate).not.toHaveBeenCalled();
    expect(parkClaims.release).not.toHaveBeenCalled();
  });

  it('still lets the pickup go out when the kernel cannot confirm the withdrawal', async () => {
    const { service, taskTermination } = setup([parkTask('running')]);
    taskTermination.terminate.mockRejectedValueOnce(new Error('kernel down'));

    await expect(service.yieldVehicle('V1', 'map-1')).resolves.toBeUndefined();
  });
});
