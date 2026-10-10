import type { Repository } from 'typeorm';
import { ReleaseEngineService } from './release-engine.service';
import { PickupDependencyService } from './pickup-dependency.service';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { TransportTaskService } from './transport-task.service';
import { ZoneGeometryService, MemberAxes } from './zone-geometry.service';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

const ZONE_ID = 'zone-pickup';

const AXES: ReadonlyArray<readonly [string, MemberAxes]> = [
  ['loc-front', { laneKey: 0, depthKey: 0 }],
  ['loc-back', { laneKey: 0, depthKey: 1000 }],
  ['loc-other-lane', { laneKey: 1000, depthKey: 1000 }],
];

const LANE_POINTS = new Map<number, Set<string>>([
  [0, new Set(['P-front', 'P-back'])],
  [1000, new Set(['P-other-lane'])],
]);

const task = (
  id: string,
  cargoId: string,
  status: TaskStatus,
  vehicleName?: string,
): TransportTaskEntity =>
  ({
    id,
    cargoId,
    status,
    metadata: vehicleName ? { assignedVehicleName: vehicleName } : {},
  }) as TransportTaskEntity;

const cargoAt = (id: string, locationName: string): CargoEntity =>
  ({
    id,
    sourceZoneId: ZONE_ID,
    sourcePickupLocationName: locationName,
    status: CargoStatus.ACTIVE,
  }) as CargoEntity;

function setup(
  tasks: TransportTaskEntity[],
  cargos: CargoEntity[],
  allocated: Record<string, string[][]> = {},
) {
  const taskRepo = {
    find: jest.fn().mockResolvedValue(tasks),
    save: jest.fn().mockImplementation((t: TransportTaskEntity) => t),
  };
  const cargoRepo = { find: jest.fn().mockResolvedValue(cargos) };
  const zoneRepo = {
    findOne: jest.fn().mockResolvedValue({ id: ZONE_ID }),
    find: jest.fn().mockResolvedValue([{ id: ZONE_ID }]),
  };
  const zoneGeometry = {
    laneIndexOf: jest.fn().mockResolvedValue({
      axesByLocation: new Map(AXES),
      pointsByLane: LANE_POINTS,
    }),
  };
  const vehicleStore = {
    get: jest.fn((name: string) =>
      name in allocated
        ? { name, allocatedResources: allocated[name] }
        : undefined,
    ),
  };
  const transportTask = {
    changeStatus: jest
      .fn()
      .mockImplementation((t: TransportTaskEntity, to: TaskStatus) => {
        t.status = to;
        return Promise.resolve(t);
      }),
  };

  const dependency = new PickupDependencyService(
    taskRepo as unknown as Repository<TransportTaskEntity>,
    cargoRepo as unknown as Repository<CargoEntity>,
    zoneRepo as unknown as Repository<ZoneEntity>,
    zoneGeometry as unknown as ZoneGeometryService,
    vehicleStore as never,
    fixedActiveMap(),
  );

  const svc = new ReleaseEngineService(
    taskRepo as unknown as Repository<TransportTaskEntity>,
    transportTask as unknown as TransportTaskService,
    dependency,
  );

  return { svc, taskRepo, transportTask };
}

function statusChanges(changeStatus: jest.Mock): Array<[string, TaskStatus]> {
  return changeStatus.mock.calls.map((call): [string, TaskStatus] => [
    (call[0] as TransportTaskEntity).id,
    call[1] as TaskStatus,
  ]);
}

describe('ReleaseEngineService', () => {
  it('leaves a blocked PICKING_UP task untouched', async () => {
    const behind = task('t-back', 'c-back', TaskStatus.PICKING_UP);
    const { svc, taskRepo, transportTask } = setup(
      [behind, task('t-front', 'c-front', TaskStatus.CREATED)],
      [cargoAt('c-back', 'loc-back'), cargoAt('c-front', 'loc-front')],
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-front', TaskStatus.READY_TO_ASSIGN],
    ]);
    expect(behind.status).toBe(TaskStatus.PICKING_UP);
    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it('lets a PICKING_UP cargo keep blocking a task behind it in the same lane', async () => {
    const behind = task('t-back', 'c-back', TaskStatus.CREATED);
    const { svc, transportTask } = setup(
      [behind, task('t-front', 'c-front', TaskStatus.PICKING_UP)],
      [cargoAt('c-back', 'loc-back'), cargoAt('c-front', 'loc-front')],
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-back', TaskStatus.BLOCKED],
    ]);
    expect(behind.metadata.blockedReason).toContain('loc-front');
  });

  it('blocks a CREATED task standing behind another at-source cargo', async () => {
    const { svc, transportTask } = setup(
      [
        task('t-back', 'c-back', TaskStatus.CREATED),
        task('t-front', 'c-front', TaskStatus.CREATED),
      ],
      [cargoAt('c-back', 'loc-back'), cargoAt('c-front', 'loc-front')],
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-back', TaskStatus.BLOCKED],
      ['t-front', TaskStatus.READY_TO_ASSIGN],
    ]);
  });

  it('blocks a READY_TO_ASSIGN task that lost its lane', async () => {
    const { svc, transportTask } = setup(
      [
        task('t-back', 'c-back', TaskStatus.READY_TO_ASSIGN),
        task('t-front', 'c-front', TaskStatus.CREATED),
      ],
      [cargoAt('c-back', 'loc-back'), cargoAt('c-front', 'loc-front')],
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toContainEqual([
      't-back',
      TaskStatus.BLOCKED,
    ]);
  });

  it('releases a BLOCKED task once nothing sits in front of it', async () => {
    const freed = task('t-back', 'c-back', TaskStatus.BLOCKED);
    freed.metadata = { blockedReason: 'Blocked by cargo at loc-front' };
    const { svc, transportTask } = setup(
      [freed],
      [cargoAt('c-back', 'loc-back')],
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-back', TaskStatus.READY_TO_ASSIGN],
    ]);
    expect(freed.metadata.blockedReason).toBeUndefined();
  });

  it('does not block across lanes', async () => {
    const { svc, transportTask } = setup(
      [
        task('t-other', 'c-other', TaskStatus.CREATED),
        task('t-front', 'c-front', TaskStatus.CREATED),
      ],
      [cargoAt('c-other', 'loc-other-lane'), cargoAt('c-front', 'loc-front')],
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-other', TaskStatus.READY_TO_ASSIGN],
      ['t-front', TaskStatus.READY_TO_ASSIGN],
    ]);
  });

  it('refreshes the reason on an already BLOCKED task without a transition', async () => {
    const blocked = task('t-back', 'c-back', TaskStatus.BLOCKED);
    const { svc, taskRepo, transportTask } = setup(
      [blocked, task('t-front', 'c-front', TaskStatus.CREATED)],
      [cargoAt('c-back', 'loc-back'), cargoAt('c-front', 'loc-front')],
    );

    await svc.run();

    expect(taskRepo.save).toHaveBeenCalledWith(blocked);
    expect(blocked.status).toBe(TaskStatus.BLOCKED);
    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-front', TaskStatus.READY_TO_ASSIGN],
    ]);
  });

  it('keeps a task blocked while the vehicle in front is still driving out of the lane', async () => {
    const behind = task('t-back', 'c-back', TaskStatus.CREATED);
    const { svc, transportTask } = setup(
      [behind, task('t-front', 'c-front', TaskStatus.DELIVERING, 'V1')],
      [cargoAt('c-back', 'loc-back'), cargoAt('c-front', 'loc-front')],
      { V1: [['P-front', 'P-front --- P-aisle']] },
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-back', TaskStatus.BLOCKED],
    ]);
    expect(behind.metadata.blockedReason).toContain('V1');
  });

  it('releases the task behind once that vehicle holds a point outside the lane', async () => {
    const behind = task('t-back', 'c-back', TaskStatus.CREATED);
    const { svc, transportTask } = setup(
      [behind, task('t-front', 'c-front', TaskStatus.DELIVERING, 'V1')],
      [cargoAt('c-back', 'loc-back'), cargoAt('c-front', 'loc-front')],
      { V1: [['P-front', 'P-aisle']] },
    );

    await svc.run();

    expect(statusChanges(transportTask.changeStatus)).toEqual([
      ['t-back', TaskStatus.READY_TO_ASSIGN],
    ]);
  });
});
