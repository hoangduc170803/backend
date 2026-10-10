import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { In } from 'typeorm';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { CargoService } from './cargo.service';
import { DeliverySlotEngine } from './delivery-slot.engine';

const deliverySlotEngine = { usableCapacityOf: jest.fn().mockResolvedValue(0) };
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import {
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { TaskStatusTransitionEntity } from './entities/task-status-transition.entity';
import { ZoneEntity, ZoneType } from '../zones/entities/zone.entity';
import type { ZoneMemberEntity } from '../zones/entities/zone-member.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { TransportTaskService } from './transport-task.service';
import { TaskTerminationService } from './task-termination.service';
import { LaneSafetyService } from './lane-safety.service';
import type { CreateCargoDto, ListCargosQueryDto } from './cargo.dto';
import { LoadHandlingGuard } from './load-handling.guard';

const DROPOFF_ZONE_ID = 'zone-dropoff';
const PICKUP_ZONE_ID = 'zone-pickup';
const DTO: CreateCargoDto = {
  sourcePointName: 'P-B',
  destinationZoneId: DROPOFF_ZONE_ID,
};

const dropoffZone = (capacity: number): ZoneEntity =>
  ({
    id: DROPOFF_ZONE_ID,
    name: 'Dropoff',
    type: ZoneType.DROPOFF,
    members: Array.from(
      { length: capacity },
      (_, index) =>
        ({
          locationName: `drop-${index}`,
          positionIndex: index,
        }) as ZoneMemberEntity,
    ),
  }) as ZoneEntity;

interface SetupOptions {
  capacity?: number;
  occupied?: number;
  occupiedCargoStatus?: CargoStatus;
  occupiedTaskStatus?: TaskStatus;
  transactionOccupied?: number;
  pickupZoneId?: string | null;
}

function setup(options: SetupOptions = {}) {
  const capacity = options.capacity ?? 5;
  const occupied = options.occupied ?? 0;
  const transactionOccupied = options.transactionOccupied ?? occupied;
  const occupiedCargoStatus = options.occupiedCargoStatus ?? CargoStatus.ACTIVE;
  const occupiedTaskStatus = options.occupiedTaskStatus ?? TaskStatus.CREATED;
  const occupiedCargos = Array.from({ length: occupied }, (_, index) => ({
    id: `occupied-${index}`,
    destinationZoneId: DROPOFF_ZONE_ID,
    status: occupiedCargoStatus,
  }));
  const occupiedTasks = occupiedCargos.map((cargo, index) => ({
    cargoId: cargo.id,
    status: occupiedTaskStatus,
    createdAt: new Date(2026, 0, index + 1),
  }));
  const transactionOccupiedCargos = Array.from(
    { length: transactionOccupied },
    (_, index) => ({
      id: `transaction-occupied-${index}`,
      destinationZoneId: DROPOFF_ZONE_ID,
      status: occupiedCargoStatus,
    }),
  );
  const transactionOccupiedTasks = transactionOccupiedCargos.map(
    (cargo, index) => ({
      cargoId: cargo.id,
      status: occupiedTaskStatus,
      createdAt: new Date(2026, 1, index + 1),
    }),
  );

  const cargoRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest
      .fn()
      .mockImplementation(
        ({ where }: { where: { destinationZoneId?: string } }) =>
          Promise.resolve(where.destinationZoneId ? occupiedCargos : []),
      ),
    count: jest.fn().mockResolvedValue(occupied),
  };
  const taskRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue(occupiedTasks),
  };
  const zoneRepo = {
    findOne: jest.fn().mockResolvedValue(dropoffZone(capacity)),
    createQueryBuilder: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest
        .fn()
        .mockResolvedValue(
          options.pickupZoneId === null
            ? null
            : ({ id: options.pickupZoneId ?? PICKUP_ZONE_ID } as ZoneEntity),
        ),
    }),
  };

  const insertedCargos: CargoEntity[] = [];
  const transactionCargoRepo = {
    count: jest.fn().mockResolvedValue(occupied),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest
      .fn()
      .mockImplementation(
        ({ where }: { where: { destinationZoneId?: string } }) =>
          Promise.resolve(
            where.destinationZoneId ? transactionOccupiedCargos : [],
          ),
      ),
    create: jest.fn().mockImplementation((data: Partial<CargoEntity>) => data),
    save: jest.fn().mockImplementation((data: CargoEntity) => {
      const saved = { ...data, id: `cargo-${insertedCargos.length + 1}` };
      insertedCargos.push(saved);
      return Promise.resolve(saved);
    }),
  };
  const transactionTaskRepo = {
    find: jest.fn().mockResolvedValue(transactionOccupiedTasks),
    create: jest
      .fn()
      .mockImplementation((data: Partial<TransportTaskEntity>) => data),
    save: jest
      .fn()
      .mockImplementation((data: TransportTaskEntity) =>
        Promise.resolve({ ...data, id: 'task-1' }),
      ),
  };
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest
      .fn()
      .mockImplementation((entity: unknown) =>
        entity === CargoEntity ? transactionCargoRepo : transactionTaskRepo,
      ),
  } as unknown as EntityManager;

  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation((work: (m: EntityManager) => Promise<unknown>) =>
        work(manager),
      ),
  };

  const kernelApi = {
    findPickupLocationForPoint: jest.fn().mockResolvedValue('loc-B'),
    getPlantModelName: jest.fn().mockResolvedValue('runtime-map'),
  };
  const transportTask = {
    publishCreated: jest.fn(),
    publishUpdated: jest.fn(),
  };
  const laneSafety = {
    clearLaneForNewCargo: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new CargoService(
    cargoRepo as unknown as Repository<CargoEntity>,
    taskRepo as unknown as Repository<TransportTaskEntity>,
    {} as unknown as Repository<TaskStatusTransitionEntity>,
    zoneRepo as unknown as Repository<ZoneEntity>,
    dataSource as unknown as DataSource,
    kernelApi as unknown as KernelApiService,
    transportTask as unknown as TransportTaskService,
    laneSafety as unknown as LaneSafetyService,
    {} as unknown as VehicleStateStore,
    {} as unknown as TaskTerminationService,
    deliverySlotEngine as unknown as DeliverySlotEngine,
    fixedActiveMap('record-runtime-map'),
    new LoadHandlingGuard(
      kernelApi as unknown as KernelApiService,
      {} as unknown as VehicleStateStore,
      { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
    ),
    entitySync as never,
  );

  return {
    svc,
    zoneRepo,
    laneSafety,
    dataSource,
    insertedCargos,
    cargoRepo,
    taskRepo,
    transactionCargoRepo,
    transactionTaskRepo,
    transportTask,
  };
}

const entitySync = {
  markRetired: jest.fn().mockResolvedValue(null),
  markRetiredMany: jest.fn().mockResolvedValue(undefined),
  viewsByCargoIds: jest.fn().mockResolvedValue(new Map()),
};

describe('CargoService.create', () => {
  it('rejects a duplicate item code within the active map', async () => {
    const { svc, cargoRepo, dataSource, insertedCargos } = setup();
    cargoRepo.findOne.mockResolvedValue({
      id: 'cargo-existing',
      itemCode: 'BOX-1',
      mapRecordId: 'record-runtime-map',
    });

    await expect(
      svc.create({ ...DTO, itemCode: 'BOX-1' }, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(cargoRepo.findOne).toHaveBeenCalledWith({
      where: {
        itemCode: 'BOX-1',
        mapRecordId: 'record-runtime-map',
      },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(insertedCargos).toHaveLength(0);
  });

  it('allows the same item code on a different map', async () => {
    const { svc, cargoRepo, insertedCargos } = setup();
    cargoRepo.findOne.mockResolvedValue(null);

    await svc.create({ ...DTO, itemCode: 'BOX-1' }, 'user-1');

    expect(insertedCargos[0].itemCode).toBe('BOX-1');
  });

  it('rejects a destination in another record even when its map name matches', async () => {
    const { svc, zoneRepo, dataSource, laneSafety } = setup();
    const otherMapZone = {
      ...dropoffZone(5),
      mapRecordId: 'other-record',
      plantModelName: 'runtime-map',
    };
    zoneRepo.findOne.mockImplementation(
      ({ where }: { where: { mapRecordId?: string } }) =>
        Promise.resolve(
          where.mapRecordId === otherMapZone.mapRecordId ? otherMapZone : null,
        ),
    );

    await expect(svc.create(DTO, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(laneSafety.clearLaneForNewCargo).not.toHaveBeenCalled();
  });

  it('resolves shared pickup location names within the active record', async () => {
    const { svc, zoneRepo } = setup();

    await svc.create(DTO, 'user-1');

    expect(zoneRepo.createQueryBuilder().andWhere).toHaveBeenCalledWith(
      'z.mapRecordId = :map',
      { map: 'record-runtime-map' },
    );
  });

  it('skips the lane guard when the source point is outside any pickup zone', async () => {
    const { svc, laneSafety, insertedCargos } = setup({ pickupZoneId: null });

    await svc.create(DTO, 'user-1');

    expect(laneSafety.clearLaneForNewCargo).not.toHaveBeenCalled();
    expect(insertedCargos).toHaveLength(1);
    expect(insertedCargos[0].sourceZoneId).toBeNull();
  });

  it('runs the lane guard for a source point inside a pickup zone', async () => {
    const { svc, laneSafety, insertedCargos } = setup();

    await svc.create(DTO, 'user-1');

    expect(laneSafety.clearLaneForNewCargo).toHaveBeenCalledWith(
      PICKUP_ZONE_ID,
      'loc-B',
    );
    expect(insertedCargos).toHaveLength(1);
  });

  it('rejects a full drop-off zone before touching any vehicle', async () => {
    const { svc, laneSafety, dataSource, insertedCargos } = setup({
      capacity: 2,
      occupied: 2,
    });

    await expect(svc.create(DTO, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(laneSafety.clearLaneForNewCargo).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(insertedCargos).toHaveLength(0);
  });

  it('does not count active cargo whose latest task has failed', async () => {
    const { svc, insertedCargos } = setup({
      capacity: 1,
      occupied: 1,
      occupiedTaskStatus: TaskStatus.FAILED,
    });

    await svc.create(DTO, 'user-1');

    expect(insertedCargos).toHaveLength(1);
  });

  it('still counts delivered cargo because it physically occupies a slot', async () => {
    const { svc, dataSource } = setup({
      capacity: 1,
      occupied: 1,
      occupiedCargoStatus: CargoStatus.DELIVERED,
      occupiedTaskStatus: TaskStatus.FAILED,
    });

    await expect(svc.create(DTO, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('creates nothing when the lane guard refuses the placement', async () => {
    const { svc, laneSafety, dataSource, insertedCargos, transportTask } =
      setup();
    laneSafety.clearLaneForNewCargo.mockRejectedValue(
      new BadRequestException('xe V1 đã được lệnh vào dãy này'),
    );

    await expect(svc.create(DTO, 'user-1')).rejects.toThrow(/V1/);

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(insertedCargos).toHaveLength(0);
    expect(transportTask.publishCreated).not.toHaveBeenCalled();
  });

  it('creates nothing when withdrawing the preempted order fails', async () => {
    const { svc, laneSafety, dataSource, insertedCargos } = setup();
    laneSafety.clearLaneForNewCargo.mockRejectedValue(new Error('kernel down'));

    await expect(svc.create(DTO, 'user-1')).rejects.toThrow('kernel down');

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(insertedCargos).toHaveLength(0);
  });

  it('re-checks capacity under the advisory lock after preempting', async () => {
    const { svc, laneSafety, insertedCargos } = setup({
      transactionOccupied: 5,
    });

    await expect(svc.create(DTO, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(laneSafety.clearLaneForNewCargo).toHaveBeenCalledTimes(1);
    expect(insertedCargos).toHaveLength(0);
  });

  it('re-checks the source point under its own advisory lock, closing the create/create race', async () => {
    const { svc, transactionCargoRepo, transactionTaskRepo, insertedCargos } =
      setup();
    // Simulates a second concurrent create() that reached the lock first and committed: the
    // pre-transaction check (still mocked as "free") already passed, so only this in-transaction
    // re-check can catch it. Its task hasn't reached pickup yet, so the point is still occupied.
    transactionCargoRepo.find.mockResolvedValue([
      { id: 'cargo-racer', itemCode: 'RACER-1' },
    ]);
    transactionTaskRepo.find.mockResolvedValue([
      {
        cargoId: 'cargo-racer',
        status: TaskStatus.CREATED,
        createdAt: new Date(),
      },
    ]);

    await expect(svc.create(DTO, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(transactionCargoRepo.find).toHaveBeenCalledWith({
      where: {
        sourcePointName: DTO.sourcePointName,
        mapRecordId: 'record-runtime-map',
        status: CargoStatus.ACTIVE,
      },
    });
    expect(insertedCargos).toHaveLength(0);
  });

  it('does not block a same-named source point from another map', async () => {
    const { svc, cargoRepo, taskRepo, insertedCargos } = setup();
    cargoRepo.find.mockImplementation(
      ({ where }: { where: { mapRecordId?: string } }) =>
        where.mapRecordId === 'record-runtime-map'
          ? []
          : [
              {
                id: 'cargo-other-map',
                itemCode: 'OTHER-MAP-1',
                mapRecordId: 'other-record',
              },
            ],
    );
    taskRepo.find.mockResolvedValue([]);

    await svc.create(DTO, 'user-1');

    expect(insertedCargos).toHaveLength(1);
    expect(cargoRepo.find).toHaveBeenCalledWith({
      where: {
        sourcePointName: DTO.sourcePointName,
        mapRecordId: 'record-runtime-map',
        status: CargoStatus.ACTIVE,
      },
    });
  });

  it('blocks a new cargo while the earlier one at the same point has not been picked up yet', async () => {
    const { svc, cargoRepo, taskRepo, insertedCargos } = setup();
    cargoRepo.find.mockResolvedValue([
      { id: 'cargo-earlier', itemCode: 'EARLIER-1' },
    ]);
    taskRepo.find.mockResolvedValue([
      {
        cargoId: 'cargo-earlier',
        status: TaskStatus.READY_TO_ASSIGN,
        createdAt: new Date(),
      },
    ]);

    await expect(svc.create(DTO, 'user-1')).rejects.toThrow(/EARLIER-1/);
    expect(insertedCargos).toHaveLength(0);
  });

  it('allows a new cargo once the earlier one at the same point has been picked up, even though it is still ACTIVE', async () => {
    const { svc, cargoRepo, taskRepo, insertedCargos } = setup();
    // The earlier cargo's trip isn't DELIVERED yet (still CargoStatus.ACTIVE), but its task is
    // past pickup — the point itself is physically free again.
    cargoRepo.find.mockResolvedValue([
      { id: 'cargo-earlier', itemCode: 'EARLIER-1' },
    ]);
    taskRepo.find.mockResolvedValue([
      {
        cargoId: 'cargo-earlier',
        status: TaskStatus.DELIVERING,
        createdAt: new Date(),
      },
    ]);

    await svc.create(DTO, 'user-1');

    expect(insertedCargos).toHaveLength(1);
  });
});

const storedCargo = (id: string, itemCode: string): CargoEntity =>
  ({
    id,
    itemCode,
    sourcePointName: 'P-B',
    sourcePickupLocationName: 'loc-B',
    destinationLocationName: null,
    status: CargoStatus.ACTIVE,
    createdBy: null,
  }) as CargoEntity;

const storedTask = (
  cargoId: string,
  status: TaskStatus,
  metadata: TransportTaskEntity['metadata'] = {},
): TransportTaskEntity =>
  ({ id: `task-${cargoId}`, cargoId, status, metadata }) as TransportTaskEntity;

function listSetup(
  cargos: CargoEntity[] = [],
  tasks: TransportTaskEntity[] = [],
  total: number = cargos.length,
) {
  const conditions: string[] = [];
  const parameters: Record<string, unknown> = {};
  const paging = { skip: null as number | null, take: null as number | null };

  const builder = {
    leftJoin: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([cargos, total]),
  };
  builder.leftJoin.mockImplementation(
    (table: string, alias: string, condition: string) => {
      conditions.push(`JOIN ${table} ${alias} ON ${condition}`);
      return builder;
    },
  );
  builder.andWhere.mockImplementation(
    (condition: string, params: Record<string, unknown> = {}) => {
      conditions.push(condition);
      Object.assign(parameters, params);
      return builder;
    },
  );
  builder.orderBy.mockReturnValue(builder);
  builder.skip.mockImplementation((value: number) => {
    paging.skip = value;
    return builder;
  });
  builder.take.mockImplementation((value: number) => {
    paging.take = value;
    return builder;
  });

  const cargoRepo = { createQueryBuilder: jest.fn().mockReturnValue(builder) };
  const taskRepo = { find: jest.fn().mockResolvedValue(tasks) };
  const kernelApi = {
    findPointForLocation: jest.fn().mockResolvedValue(null),
    getPlantModelName: jest.fn().mockResolvedValue('runtime-map'),
  };

  const svc = new CargoService(
    cargoRepo as unknown as Repository<CargoEntity>,
    taskRepo as unknown as Repository<TransportTaskEntity>,
    {} as unknown as Repository<TaskStatusTransitionEntity>,
    {} as unknown as Repository<ZoneEntity>,
    {} as unknown as DataSource,
    kernelApi as unknown as KernelApiService,
    {} as unknown as TransportTaskService,
    {} as unknown as LaneSafetyService,
    {} as unknown as VehicleStateStore,
    {} as unknown as TaskTerminationService,
    deliverySlotEngine as unknown as DeliverySlotEngine,
    fixedActiveMap('record-runtime-map'),
    new LoadHandlingGuard(
      kernelApi as unknown as KernelApiService,
      {} as unknown as VehicleStateStore,
      { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
    ),
    entitySync as never,
  );

  const listWith = (query: ListCargosQueryDto = {}) => svc.list(query);
  const conditionMatching = (needle: string) =>
    conditions.find((condition) => condition.includes(needle));

  return {
    svc,
    listWith,
    conditions,
    conditionMatching,
    parameters,
    paging,
    kernelApi,
  };
}

describe('CargoService.list', () => {
  it('returns the first page with no filter applied', async () => {
    const { listWith, conditions, paging } = listSetup([
      storedCargo('c-1', 'BOX-1'),
    ]);

    const result = await listWith();

    expect(conditions).toHaveLength(0);
    expect(paging).toEqual({ skip: 0, take: 20 });
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.cargos.map((cargo) => cargo.itemCode)).toEqual(['BOX-1']);
  });

  it('keeps filtering by cargo status', async () => {
    const { listWith, conditionMatching, parameters } = listSetup();

    await listWith({ status: CargoStatus.DELIVERED });

    expect(conditionMatching('cargo.status')).toBeDefined();
    expect(parameters.status).toBe(CargoStatus.DELIVERED);
  });

  it('searches item code, source point and destination location at once', async () => {
    const { listWith, conditionMatching, parameters } = listSetup();

    await listWith({ search: '  box-1 ' });

    const condition = conditionMatching('ILIKE');
    expect(condition).toContain('cargo.itemCode');
    expect(condition).toContain('cargo.sourcePointName');
    expect(condition).toContain('cargo.destinationLocationName');
    expect(parameters.search).toBe('%box-1%');
  });

  it('filters by the task status of the newest task of each cargo', async () => {
    const { listWith, conditionMatching, parameters } = listSetup();

    await listWith({ taskStatus: TaskStatus.BLOCKED });

    const condition = conditionMatching('transport_requests');
    expect(condition).toContain('EXISTS');
    expect(condition).toContain('MAX(any_task.created_at)');
    expect(parameters.taskStatus).toBe(TaskStatus.BLOCKED);
  });

  it('combines every filter into one query', async () => {
    const { listWith, conditions } = listSetup();

    await listWith({
      status: CargoStatus.ACTIVE,
      taskStatus: TaskStatus.READY_TO_ASSIGN,
      search: 'box',
    });

    expect(conditions).toHaveLength(3);
  });

  it('translates page and limit into skip and take', async () => {
    const { listWith, paging } = listSetup();

    const result = await listWith({ page: 3, limit: 50 });

    expect(paging).toEqual({ skip: 100, take: 50 });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(50);
  });

  it('scopes to the currently loaded map when activeMapOnly is set', async () => {
    const { listWith, conditionMatching, parameters, kernelApi } = listSetup();

    await listWith({ activeMapOnly: true });

    expect(kernelApi.getPlantModelName).not.toHaveBeenCalled();
    const condition = conditionMatching('cargo.map_record_id');
    expect(condition).toBeDefined();
    expect(parameters.mapIds).toEqual(['record-runtime-map']);
  });

  it('applies no filter at all when activeMapOnly is left off', async () => {
    const { listWith, conditions, kernelApi } = listSetup();

    await listWith();

    expect(kernelApi.getPlantModelName).not.toHaveBeenCalled();
    expect(conditions).toHaveLength(0);
  });

  it('reports truncated when the page did not reach the full total', async () => {
    const { listWith } = listSetup([storedCargo('c-1', 'BOX-1')], [], 5);

    const result = await listWith({ page: 1, limit: 1 });

    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated once the page covers the full total', async () => {
    const { listWith } = listSetup([storedCargo('c-1', 'BOX-1')], [], 1);

    const result = await listWith({ page: 1, limit: 200 });

    expect(result.truncated).toBe(false);
  });

  it('surfaces the block reason of the linked task', async () => {
    const blocked = storedTask('c-1', TaskStatus.BLOCKED, {
      blockedReason: 'Blocked by cargo at loc-front',
    });
    const { listWith } = listSetup([storedCargo('c-1', 'BOX-1')], [blocked]);

    const result = await listWith({ taskStatus: TaskStatus.BLOCKED });

    expect(result.cargos[0].taskStatus).toBe(TaskStatus.BLOCKED);
    expect(result.cargos[0].blockedReason).toBe(
      'Blocked by cargo at loc-front',
    );
  });

  it('reports no block reason for a task that carries none', async () => {
    const { listWith } = listSetup(
      [storedCargo('c-1', 'BOX-1')],
      [storedTask('c-1', TaskStatus.DELIVERING)],
    );

    const result = await listWith();

    expect(result.cargos[0].blockedReason).toBeNull();
  });
});

const ASSIGNMENT_CONTEXT = {
  pickupOrderName: 'PICKUP-V1-loc-B-abc',
  distanceToSource: 1200,
  matcher: 'hungarian',
  batchSize: 3,
  altVehicleName: 'V2',
  altDistanceToSource: 900,
  approachDistance: 4500,
};

const assignmentTransition = (
  context: Record<string, unknown>,
): TaskStatusTransitionEntity => ({
  id: '42',
  taskId: 'task-c-1',
  fromStatus: TaskStatus.READY_TO_ASSIGN,
  toStatus: TaskStatus.PICKING_UP,
  trigger: 'ASSIGNMENT_ENGINE',
  vehicleName: 'V1',
  reason: null,
  context,
  occurredAt: new Date('2026-08-04T10:00:00.000Z'),
});

interface DecisionSetupOptions {
  cargo?: CargoEntity | null;
  task?: TransportTaskEntity | null;
  transition?: TaskStatusTransitionEntity | null;
}

function decisionSetup(options: DecisionSetupOptions = {}) {
  const cargo =
    options.cargo === undefined ? storedCargo('c-1', 'BOX-1') : options.cargo;
  const task =
    options.task === undefined
      ? storedTask('c-1', TaskStatus.PICKING_UP)
      : options.task;
  const transition =
    options.transition === undefined
      ? assignmentTransition(ASSIGNMENT_CONTEXT)
      : options.transition;

  const cargoRepo = { findOne: jest.fn().mockResolvedValue(cargo) };
  const taskRepo = { findOne: jest.fn().mockResolvedValue(task) };
  const transitionRepo = { findOne: jest.fn().mockResolvedValue(transition) };

  const svc = new CargoService(
    cargoRepo as unknown as Repository<CargoEntity>,
    taskRepo as unknown as Repository<TransportTaskEntity>,
    transitionRepo as unknown as Repository<TaskStatusTransitionEntity>,
    {} as unknown as Repository<ZoneEntity>,
    {} as unknown as DataSource,
    {} as unknown as KernelApiService,
    {} as unknown as TransportTaskService,
    {} as unknown as LaneSafetyService,
    {} as unknown as VehicleStateStore,
    {} as unknown as TaskTerminationService,
    deliverySlotEngine as unknown as DeliverySlotEngine,
    fixedActiveMap('record-runtime-map'),
    new LoadHandlingGuard(
      {} as unknown as KernelApiService,
      {} as unknown as VehicleStateStore,
      { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
    ),
    entitySync as never,
  );

  return { svc, transitionRepo };
}

describe('CargoService.getAssignmentDecision', () => {
  it('reads the assignment transition of the task', async () => {
    const { svc, transitionRepo } = decisionSetup();

    await svc.getAssignmentDecision('c-1');

    expect(transitionRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskId: 'task-c-1',
          trigger: 'ASSIGNMENT_ENGINE',
          toStatus: TaskStatus.PICKING_UP,
        },
      }),
    );
  });

  it('reports the matcher, the batch it belonged to and both distances', async () => {
    const { svc } = decisionSetup();

    const decision = await svc.getAssignmentDecision('c-1');

    expect(decision).toEqual({
      cargoId: 'c-1',
      taskId: 'task-c-1',
      decidedAt: new Date('2026-08-04T10:00:00.000Z'),
      vehicleName: 'V1',
      matcher: 'hungarian',
      matchedRequestCount: 3,
      distanceToSource: 1200,
      approachDistance: 4500,
      alternative: {
        matcher: 'greedy',
        vehicleName: 'V2',
        distanceToSource: 900,
      },
    });
  });

  it('names hungarian as the alternative when greedy made the decision', async () => {
    const { svc } = decisionSetup({
      transition: assignmentTransition({
        ...ASSIGNMENT_CONTEXT,
        matcher: 'greedy',
      }),
    });

    const decision = await svc.getAssignmentDecision('c-1');

    expect(decision.matcher).toBe('greedy');
    expect(decision.alternative?.matcher).toBe('hungarian');
  });

  it('omits the alternative when the other matcher chose no vehicle', async () => {
    const { svc } = decisionSetup({
      transition: assignmentTransition({
        ...ASSIGNMENT_CONTEXT,
        altVehicleName: null,
        altDistanceToSource: null,
      }),
    });

    const decision = await svc.getAssignmentDecision('c-1');

    expect(decision.alternative).toBeNull();
  });

  it('reports missing measurements as null instead of guessing', async () => {
    const { svc } = decisionSetup({
      transition: assignmentTransition({ matcher: 'hungarian' }),
    });

    const decision = await svc.getAssignmentDecision('c-1');

    expect(decision.matchedRequestCount).toBeNull();
    expect(decision.distanceToSource).toBeNull();
    expect(decision.approachDistance).toBeNull();
    expect(decision.alternative).toBeNull();
  });

  it('rejects an unknown cargo', async () => {
    const { svc } = decisionSetup({ cargo: null });

    await expect(svc.getAssignmentDecision('c-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a cargo with no transport request', async () => {
    const { svc } = decisionSetup({ task: null });

    await expect(svc.getAssignmentDecision('c-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a request that has not been assigned yet', async () => {
    const { svc } = decisionSetup({ transition: null });

    await expect(svc.getAssignmentDecision('c-1')).rejects.toThrow(
      /not been assigned/,
    );
  });
});

const DROP_SLOT = 'drop-1';
const DROP_POINT = 'P-D1';

interface RemoveSetupOptions {
  cargos?: CargoEntity[];
  tasks?: TransportTaskEntity[];
  cargo?: CargoEntity | null;
  task?: TransportTaskEntity | null;
  allocated?: string[][] | null;
  connected?: boolean;
}

function removeSetup(options: RemoveSetupOptions = {}) {
  const cargo =
    options.cargo === undefined ? storedCargo('c-1', 'BOX-1') : options.cargo;
  const task = options.task ?? null;

  const cargoRepo = {
    findOne: jest.fn().mockResolvedValue(cargo),
    find: jest.fn().mockResolvedValue(options.cargos ?? (cargo ? [cargo] : [])),
    softDelete: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const taskRepo = {
    findOne: jest.fn().mockResolvedValue(task),
    find: jest.fn().mockResolvedValue(options.tasks ?? (task ? [task] : [])),
  };
  const kernelApi = {
    findPointForLocation: jest.fn().mockResolvedValue(DROP_POINT),
    getVehicleStates: jest.fn().mockResolvedValue([]),
  };
  const vehicleStore = {
    isConnected: jest.fn().mockReturnValue(options.connected ?? true),
    get: jest
      .fn()
      .mockReturnValue(
        options.allocated === null
          ? undefined
          : { allocatedResources: options.allocated ?? [] },
      ),
  };
  const taskTermination = { terminate: jest.fn().mockResolvedValue(undefined) };
  const transportTask = { publishUpdated: jest.fn() };
  const activeMap = { id: jest.fn().mockResolvedValue('record-runtime-map') };

  const svc = new CargoService(
    cargoRepo as unknown as Repository<CargoEntity>,
    taskRepo as unknown as Repository<TransportTaskEntity>,
    {} as unknown as Repository<TaskStatusTransitionEntity>,
    {} as unknown as Repository<ZoneEntity>,
    {} as unknown as DataSource,
    kernelApi as unknown as KernelApiService,
    transportTask as unknown as TransportTaskService,
    {} as unknown as LaneSafetyService,
    vehicleStore as unknown as VehicleStateStore,
    taskTermination as unknown as TaskTerminationService,
    deliverySlotEngine as unknown as DeliverySlotEngine,
    activeMap as never,
    new LoadHandlingGuard(
      kernelApi as unknown as KernelApiService,
      vehicleStore as unknown as VehicleStateStore,
      { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
    ),
    entitySync as never,
  );

  return {
    svc,
    cargoRepo,
    taskRepo,
    taskTermination,
    kernelApi,
    transportTask,
    activeMap,
  };
}

const droppingOffTask = (metadata: TransportTaskEntity['metadata'] = {}) =>
  storedTask('c-1', TaskStatus.DELIVERING, {
    assignedVehicleName: 'V1',
    dropoffOrderName: 'DROPOFF-V1-drop-1-uuid',
    ...metadata,
  });

const cargoHeadingTo = (slot: string): CargoEntity => ({
  ...storedCargo('c-1', 'BOX-1'),
  destinationLocationName: slot,
});

describe('CargoService.remove', () => {
  it('deletes a cargo that never got a transport request', async () => {
    const { svc, cargoRepo, taskTermination } = removeSetup();

    await expect(svc.remove('c-1')).resolves.toEqual({
      message: 'Cargo deleted.',
    });

    expect(taskTermination.terminate).not.toHaveBeenCalled();
    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-1']) },
      {
        status: CargoStatus.CANCELLED,
        deletedAt: expect.any(Date),
      },
    );
  });

  it('rejects a cargo that does not exist', async () => {
    const { svc, cargoRepo } = removeSetup({ cargo: null });

    await expect(svc.remove('c-1')).rejects.toBeInstanceOf(NotFoundException);

    expect(cargoRepo.update).not.toHaveBeenCalledWith(
      { id: In(['c-1']) },
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('cancels the newest task of the cargo and marks the cargo cancelled', async () => {
    const { svc, taskRepo, cargoRepo, taskTermination } = removeSetup({
      task: storedTask('c-1', TaskStatus.READY_TO_ASSIGN),
    });

    await svc.remove('c-1');

    expect(taskRepo.findOne).toHaveBeenCalledWith({
      where: { cargoId: 'c-1' },
      order: { createdAt: 'DESC' },
    });
    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-c-1' }),
      TaskStatus.CANCELLED,
      { trigger: 'API', reason: 'cargo deleted' },
      expect.objectContaining({ onLoadedMap: expect.any(Boolean) }),
    );
    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-1']) },
      {
        status: CargoStatus.CANCELLED,
        deletedAt: expect.any(Date),
      },
    );
  });

  it('uses the loaded map it is given instead of resolving it again', async () => {
    const { svc, taskTermination, activeMap } = removeSetup({
      task: storedTask('c-1', TaskStatus.READY_TO_ASSIGN),
    });

    await svc.remove('c-1', null);

    expect(activeMap.id).not.toHaveBeenCalled();
    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.anything(),
      TaskStatus.CANCELLED,
      expect.anything(),
      { onLoadedMap: false },
    );
  });

  it('deletes while the AGV is still driving to the pickup point', async () => {
    const { svc, cargoRepo, taskTermination } = removeSetup({
      task: storedTask('c-1', TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
      }),
      allocated: [['P-Z'], ['P-Z --- P-Y']],
    });

    await svc.remove('c-1');

    expect(taskTermination.terminate).toHaveBeenCalled();
    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-1']) },
      {
        status: CargoStatus.CANCELLED,
        deletedAt: expect.any(Date),
      },
    );
  });

  it('refuses once the AGV holds the pickup point', async () => {
    const { svc, cargoRepo, taskTermination } = removeSetup({
      task: storedTask('c-1', TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
      }),
      allocated: [['P-B']],
    });

    await expect(svc.remove('c-1')).rejects.toBeInstanceOf(BadRequestException);

    expect(taskTermination.terminate).not.toHaveBeenCalled();
    expect(cargoRepo.update).not.toHaveBeenCalledWith(
      { id: In(['c-1']) },
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('refuses once the AGV holds the drop-off point', async () => {
    const { svc, cargoRepo } = removeSetup({
      cargo: cargoHeadingTo(DROP_SLOT),
      task: droppingOffTask(),
      allocated: [[DROP_POINT]],
    });

    await expect(svc.remove('c-1')).rejects.toThrow(/V1/);

    expect(cargoRepo.update).not.toHaveBeenCalledWith(
      { id: In(['c-1']) },
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('deletes once the load is down and the retreat leg is running', async () => {
    const { svc, cargoRepo } = removeSetup({
      cargo: cargoHeadingTo(DROP_SLOT),
      task: droppingOffTask({ unloadedAt: '2026-08-12T10:00:00.000Z' }),
      allocated: [[DROP_POINT]],
    });

    await svc.remove('c-1');

    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-1']) },
      {
        status: CargoStatus.CANCELLED,
        deletedAt: expect.any(Date),
      },
    );
  });

  it('reads a path resource as a path, not as the point it leads to', async () => {
    const { svc, cargoRepo } = removeSetup({
      task: storedTask('c-1', TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
      }),
      allocated: [['P-A --- P-B']],
    });

    await svc.remove('c-1');

    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-1']) },
      {
        status: CargoStatus.CANCELLED,
        deletedAt: expect.any(Date),
      },
    );
  });

  it('deletes when the fleet state cannot be read at all', async () => {
    const { svc, cargoRepo } = removeSetup({
      task: storedTask('c-1', TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
      }),
      allocated: null,
    });

    await svc.remove('c-1');

    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-1']) },
      {
        status: CargoStatus.CANCELLED,
        deletedAt: expect.any(Date),
      },
    );
  });

  it('falls back to the kernel when the event stream is down', async () => {
    const { svc, cargoRepo, kernelApi } = removeSetup({
      task: storedTask('c-1', TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
      }),
      connected: false,
    });
    kernelApi.getVehicleStates.mockResolvedValue([
      { name: 'V1', allocatedResources: [['P-B']] },
    ]);

    await expect(svc.remove('c-1')).rejects.toBeInstanceOf(BadRequestException);

    expect(cargoRepo.update).not.toHaveBeenCalledWith(
      { id: In(['c-1']) },
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });

  it('fails closed — refuses to delete when the kernel cannot be reached either', async () => {
    const { svc, cargoRepo, kernelApi } = removeSetup({
      task: storedTask('c-1', TaskStatus.PICKING_UP, {
        assignedVehicleName: 'V1',
      }),
      connected: false,
    });
    kernelApi.getVehicleStates.mockRejectedValue(new Error('kernel down'));

    await expect(svc.remove('c-1')).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(cargoRepo.update).not.toHaveBeenCalledWith(
      { id: In(['c-1']) },
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });
});

describe('CargoService.failCargo', () => {
  it('cancels the task, withdraws its orders and keeps the cargo as FAILED', async () => {
    const { svc, cargoRepo, taskTermination } = removeSetup({
      task: storedTask('c-1', TaskStatus.DELIVERING),
    });

    await svc.failCargo('c-1', 'Xe V1 mất kết nối', {
      trigger: 'DISCONNECT_WATCHER',
    });

    expect(taskTermination.terminate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-c-1',
        cancelledAt: expect.any(Date),
      }),
      TaskStatus.CANCELLED,
      expect.objectContaining({ reason: 'Xe V1 mất kết nối' }),
      expect.objectContaining({ onLoadedMap: expect.any(Boolean) }),
    );
    expect(cargoRepo.update).toHaveBeenCalledWith('c-1', {
      status: CargoStatus.FAILED,
    });
    expect(cargoRepo.update).not.toHaveBeenCalledWith(
      { id: In(['c-1']) },
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
  });
});

describe('CargoService.removeManyOnMap', () => {
  const onMap = (id: string): CargoEntity => ({
    ...storedCargo(id, `BOX-${id}`),
    mapRecordId: 'map-a',
  });

  it('loads every cargo and its task once, then soft-deletes them in one statement', async () => {
    const { svc, cargoRepo, taskRepo, taskTermination } = removeSetup({
      cargos: [onMap('c-1'), onMap('c-2')],
      tasks: [storedTask('c-1', TaskStatus.READY_TO_ASSIGN)],
    });

    const outcomes = await svc.removeManyOnMap(['c-1', 'c-2'], 'map-a');

    expect(outcomes).toEqual([
      { cargoId: 'c-1', reason: null },
      { cargoId: 'c-2', reason: null },
    ]);
    expect(cargoRepo.find).toHaveBeenCalledTimes(1);
    expect(taskRepo.find).toHaveBeenCalledTimes(1);
    expect(cargoRepo.findOne).not.toHaveBeenCalled();
    expect(taskTermination.terminate).toHaveBeenCalledTimes(1);
    expect(cargoRepo.update).toHaveBeenCalledTimes(1);
    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-1', 'c-2']) },
      { status: CargoStatus.CANCELLED, deletedAt: expect.any(Date) },
    );
    expect(entitySync.markRetiredMany).toHaveBeenCalledWith(
      ['c-1', 'c-2'],
      expect.any(String),
    );
  });

  it('deletes each id once, refuses unknown and other-map cargo, keeps going after a failure', async () => {
    const { svc, cargoRepo, taskTermination } = removeSetup({
      cargos: [
        onMap('c-1'),
        { ...onMap('c-2'), mapRecordId: 'map-b' },
        onMap('c-3'),
      ],
      tasks: [
        storedTask('c-1', TaskStatus.READY_TO_ASSIGN),
        storedTask('c-3', TaskStatus.READY_TO_ASSIGN),
      ],
    });
    taskTermination.terminate
      .mockRejectedValueOnce(new Error('Xe V1 đang nâng hàng'))
      .mockResolvedValue(undefined);

    const outcomes = await svc.removeManyOnMap(
      ['c-1', 'c-1', 'c-2', 'c-3', 'c-9'],
      'map-a',
    );

    expect(
      outcomes.map((outcome) => [outcome.cargoId, outcome.reason]),
    ).toEqual([
      ['c-1', 'Xe V1 đang nâng hàng'],
      ['c-2', 'Không tìm thấy hàng trên bản đồ đang tải.'],
      ['c-3', null],
      ['c-9', 'Cargo not found.'],
    ]);
    expect(cargoRepo.update).toHaveBeenCalledWith(
      { id: In(['c-3']) },
      { status: CargoStatus.CANCELLED, deletedAt: expect.any(Date) },
    );
  });
});
