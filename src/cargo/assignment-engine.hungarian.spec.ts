import { AssignmentEngineService } from './assignment-engine.service';
import { DispatchDistanceService } from './dispatch-distance.service';
import { VehicleCandidateService } from './vehicle-candidate.service';
import { PickupOrderService } from './pickup-order.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ORDER_PROP } from '../opentcs/domain/transport-order';
import { buildRoadGraph } from './domain/routing';
import { TaskStatus } from './entities/transport-task.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../maps/infrastructure/active-map-context.testing';

const twoWay = (from: string, to: string, length: number) => ({
  from,
  to,
  length,
  maxVelocity: 1,
  maxReverseVelocity: 1,
});

const stub = <T>(value: unknown): T => value as T;

describe('AssignmentEngineService Hungarian dispatch', () => {
  function build(
    blockedTaskIds: ReadonlySet<string> = new Set(),
    activeMapId: string | null = TEST_MAP_ID,
  ) {
    const tasks = [
      {
        id: 't1',
        cargoId: 'c1',
        mapRecordId: TEST_MAP_ID,
        status: TaskStatus.READY_TO_ASSIGN,
        metadata: {},
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 't2',
        cargoId: 'c2',
        mapRecordId: TEST_MAP_ID,
        status: TaskStatus.READY_TO_ASSIGN,
        metadata: {},
        createdAt: new Date('2026-01-01T00:00:01Z'),
      },
      {
        id: 't3',
        cargoId: 'c3',
        mapRecordId: TEST_MAP_ID,
        status: TaskStatus.READY_TO_ASSIGN,
        metadata: {},
        createdAt: new Date('2026-01-01T00:00:02Z'),
      },
    ];
    const cargos = new Map([
      [
        'c1',
        {
          id: 'c1',
          sourcePickupLocationName: 'LOC-1',
          mapRecordId: TEST_MAP_ID,
          sourcePointName: 'S1',
        },
      ],
      [
        'c2',
        {
          id: 'c2',
          sourcePickupLocationName: 'LOC-2',
          mapRecordId: TEST_MAP_ID,
          sourcePointName: 'S2',
        },
      ],
      [
        'c3',
        {
          id: 'c3',
          sourcePickupLocationName: 'LOC-3',
          mapRecordId: TEST_MAP_ID,
          sourcePointName: 'S1',
        },
      ],
    ]);

    const zones = new Map<string, { id: string }>();
    const feedersByZone = new Map<string, string[]>();

    const taskRepo = {
      find: jest
        .fn()
        .mockImplementation((opts: { where?: { status?: unknown } }) =>
          opts?.where?.status === TaskStatus.READY_TO_ASSIGN
            ? Promise.resolve(tasks)
            : Promise.resolve([]),
        ),
    };
    const cargoRepo = {
      findOne: jest
        .fn()
        .mockImplementation((opts: { where: { id: string } }) =>
          Promise.resolve(cargos.get(opts.where.id) ?? null),
        ),
    };
    const agvRepo = {
      find: jest.fn().mockResolvedValue([
        {
          name: 'V1',
          isDispatchEnabled: true,
          isIgnored: false,
          criticalBatteryThreshold: 20,
        },
        {
          name: 'V2',
          isDispatchEnabled: true,
          isIgnored: false,
          criticalBatteryThreshold: 20,
        },
      ]),
    };
    const kernelApi = {
      withdrawTransportOrder: jest.fn().mockResolvedValue(undefined),
      createTransportOrder: jest.fn().mockResolvedValue(undefined),
      loadOperation: 'PICK_UP',
      unloadOperation: 'DROP_OFF',
    };
    const states = new Map([
      [
        'V1',
        {
          state: 'IDLE',
          procState: 'IDLE',
          integrationLevel: 'TO_BE_UTILIZED',
          transportOrder: null,
          currentPosition: 'S2',
          energyLevel: 80,
        },
      ],
      [
        'V2',
        {
          state: 'IDLE',
          procState: 'IDLE',
          integrationLevel: 'TO_BE_UTILIZED',
          transportOrder: null,
          currentPosition: 'V2-POS',
          energyLevel: 80,
        },
      ],
    ]);
    const vehicleStore = {
      get: jest.fn().mockImplementation((name: string) => states.get(name)),
    };
    const transportTask = {
      changeStatus: jest.fn().mockResolvedValue(undefined),
    };
    const pickupDependency = {
      isBlocked: jest
        .fn()
        .mockImplementation((task: { id: string }) =>
          Promise.resolve(blockedTaskIds.has(task.id)),
        ),
      blockedTaskIds: jest.fn(),
    };
    pickupDependency.blockedTaskIds.mockImplementation(async () => {
      const blocked = new Set<string>();
      for (const task of tasks) {
        if (await pickupDependency.isBlocked(task)) blocked.add(task.id);
      }
      return blocked;
    });
    const dispatchPolicy = {
      getActiveWeights: jest.fn().mockResolvedValue(null),
    };
    const routing = {
      getReverseRoadGraph: jest
        .fn()
        .mockResolvedValue(
          buildRoadGraph([twoWay('S2', 'S1', 4), twoWay('S1', 'V2-POS', 6)]),
        ),
    };

    const zoneRepo = {
      findOne: jest
        .fn()
        .mockImplementation((opts: { where: { id: string } }) =>
          Promise.resolve(zones.get(opts.where.id) ?? null),
        ),
    };
    const approachPoint = {
      feederPointsOf: jest
        .fn()
        .mockImplementation((zone: { id: string }) =>
          Promise.resolve(feedersByZone.get(zone.id) ?? []),
        ),
    };
    const service = new AssignmentEngineService(
      stub(taskRepo),
      stub(cargoRepo),
      stub(pickupDependency),
      stub(dispatchPolicy),
      new DispatchDistanceService(
        stub(zoneRepo),
        stub(routing),
        stub(approachPoint),
      ),
      new VehicleCandidateService(stub(agvRepo), stub(vehicleStore)),
      new PickupOrderService(
        stub(kernelApi),
        new TransportOrderService(stub(kernelApi)),
        stub(transportTask),
      ),
      fixedActiveMap(activeMapId),
      stub({ yieldVehicle: jest.fn().mockResolvedValue(undefined) }),
      stub({
        openRound: () =>
          Promise.resolve({ admit: () => Promise.resolve(true) }),
      }),
    );
    return {
      service,
      taskRepo,
      agvRepo,
      cargos,
      dispatchPolicy,
      kernelApi,
      pickupDependency,
      routing,
      transportTask,
    };
  }

  it('dispatches the global minimum-cost pairing instead of the greedy pairing', async () => {
    const { service, kernelApi, transportTask } = build();

    await service.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(2);
    expect(kernelApi.createTransportOrder).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^PICKUP-/),
      [{ locationName: 'LOC-1', operation: 'PICK_UP' }],
      'V2',
      { [ORDER_PROP.TASK_ID]: 't1', [ORDER_PROP.LEG]: 'PICKUP' },
      { dispensable: false },
    );
    expect(kernelApi.createTransportOrder).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^PICKUP-/),
      [{ locationName: 'LOC-2', operation: 'PICK_UP' }],
      'V1',
      { [ORDER_PROP.TASK_ID]: 't2', [ORDER_PROP.LEG]: 'PICKUP' },
      { dispensable: false },
    );
    expect(transportTask.changeStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 't1' }),
      TaskStatus.PICKING_UP,
      expect.objectContaining({
        context: expect.objectContaining({ distanceToSource: 6 }),
      }),
    );
    expect(transportTask.changeStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 't2' }),
      TaskStatus.PICKING_UP,
      expect.objectContaining({
        context: expect.objectContaining({ distanceToSource: 0 }),
      }),
    );
  });

  it('skips a blocked FIFO task and fills the batch with the next task', async () => {
    const { service, kernelApi } = build(new Set(['t1']));

    await service.run();

    const dispatchedTaskIds = kernelApi.createTransportOrder.mock.calls.map(
      (call: unknown[]) =>
        (call[3] as Record<string, string>)[ORDER_PROP.TASK_ID],
    );
    expect(dispatchedTaskIds).toEqual(['t2', 't3']);
  });

  it('re-plans and backfills when a task becomes blocked after planning', async () => {
    const { service, kernelApi, pickupDependency } = build();
    const checks = new Map<string, number>();
    pickupDependency.isBlocked.mockImplementation((task: { id: string }) => {
      const count = (checks.get(task.id) ?? 0) + 1;
      checks.set(task.id, count);
      return Promise.resolve(task.id === 't1' && count === 2);
    });

    await service.run();

    const dispatchedTaskIds = kernelApi.createTransportOrder.mock.calls.map(
      (call: unknown[]) =>
        (call[3] as Record<string, string>)[ORDER_PROP.TASK_ID],
    );
    expect(dispatchedTaskIds).toEqual(['t2', 't3']);
  });

  it('dispatches the rest of the batch when one task blocks just before its order goes out', async () => {
    const { service, kernelApi, pickupDependency } = build();
    const checks = new Map<string, number>();
    pickupDependency.isBlocked.mockImplementation((task: { id: string }) => {
      const count = (checks.get(task.id) ?? 0) + 1;
      checks.set(task.id, count);
      return Promise.resolve(task.id === 't1' && count === 2);
    });

    await service.run();

    const dispatchedTaskIds = kernelApi.createTransportOrder.mock.calls.map(
      (call: unknown[]) =>
        (call[3] as Record<string, string>)[ORDER_PROP.TASK_ID],
    );
    expect(dispatchedTaskIds).not.toContain('t1');
    expect(dispatchedTaskIds).toEqual(['t2', 't3']);
  });

  it('quarantines a failed vehicle but continues independent assignments', async () => {
    const { service, kernelApi, transportTask } = build();
    kernelApi.createTransportOrder.mockImplementation(
      (_name: string, _destinations: unknown, vehicleName: string) =>
        vehicleName === 'V2'
          ? Promise.reject(new Error('vehicle V2 rejected assignment'))
          : Promise.resolve(),
    );

    await service.run();

    expect(
      kernelApi.createTransportOrder.mock.calls.map(
        (call: unknown[]) => call[2],
      ),
    ).toEqual(['V2', 'V1']);
    expect(
      transportTask.changeStatus.mock.calls.map(
        (call: Array<{ id: string }>) => call[0].id,
      ),
    ).toEqual(['t2']);
  });

  it('defers a graph-unreachable task and backfills reachable work', async () => {
    const { service, cargos, kernelApi } = build();
    cargos.get('c1')!.sourcePointName = 'ISOLATED';

    await service.run();

    const dispatchedTaskIds = kernelApi.createTransportOrder.mock.calls.map(
      (call: unknown[]) =>
        (call[3] as Record<string, string>)[ORDER_PROP.TASK_ID],
    );
    expect(dispatchedTaskIds).toEqual(['t2', 't3']);
  });

  it('keeps a route-conflicted FIFO task pending when the first task invalidates', async () => {
    const { service, cargos, kernelApi, pickupDependency, routing } = build();
    cargos.get('c1')!.sourcePointName = 'A';
    cargos.get('c2')!.sourcePointName = 'A';
    cargos.get('c3')!.sourcePointName = 'B';
    routing.getReverseRoadGraph.mockResolvedValue(
      buildRoadGraph([twoWay('A', 'S2', 1), twoWay('B', 'V2-POS', 1)]),
    );
    const checks = new Map<string, number>();
    pickupDependency.isBlocked.mockImplementation((task: { id: string }) => {
      const count = (checks.get(task.id) ?? 0) + 1;
      checks.set(task.id, count);
      return Promise.resolve(task.id === 't1' && count === 2);
    });

    await service.run();

    const dispatchedTaskIds = kernelApi.createTransportOrder.mock.calls.map(
      (call: unknown[]) =>
        (call[3] as Record<string, string>)[ORDER_PROP.TASK_ID],
    );
    expect(dispatchedTaskIds).toEqual(['t2', 't3']);
  });

  it('keeps plain FIFO when a policy is active', async () => {
    const { service, dispatchPolicy, kernelApi } = build();
    dispatchPolicy.getActiveWeights.mockResolvedValue({ battery: 0 });

    await service.run();

    const dispatchedTaskIds = kernelApi.createTransportOrder.mock.calls.map(
      (call: unknown[]) =>
        (call[3] as Record<string, string>)[ORDER_PROP.TASK_ID],
    );
    expect(dispatchedTaskIds).toEqual(['t1', 't2']);
  });

  it('excludes an ambiguous duplicate vehicle name from dispatch', async () => {
    const { service, agvRepo, kernelApi } = build();
    agvRepo.find.mockResolvedValue([
      {
        id: 'duplicate-1',
        name: 'V1',
        isDispatchEnabled: true,
        isIgnored: false,
        criticalBatteryThreshold: 20,
      },
      {
        id: 'duplicate-2',
        name: 'V1',
        isDispatchEnabled: true,
        isIgnored: false,
        criticalBatteryThreshold: 20,
      },
    ]);

    await service.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  describe('DISPATCH_MATCHER', () => {
    const originalMatcher = process.env.DISPATCH_MATCHER;

    afterEach(() => {
      if (originalMatcher === undefined) delete process.env.DISPATCH_MATCHER;
      else process.env.DISPATCH_MATCHER = originalMatcher;
    });

    const dispatchedVehicleFor = (
      kernelApi: { createTransportOrder: jest.Mock },
      call: number,
    ): string =>
      kernelApi.createTransportOrder.mock.calls[call - 1][2] as string;

    it('dispatches the greedy pairing and records the hungarian counterfactual', async () => {
      process.env.DISPATCH_MATCHER = 'greedy';
      const { service, kernelApi, transportTask } = build();

      await service.run();

      expect(dispatchedVehicleFor(kernelApi, 1)).toBe('V1');
      expect(dispatchedVehicleFor(kernelApi, 2)).toBe('V2');
      expect(transportTask.changeStatus).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 't1' }),
        TaskStatus.PICKING_UP,
        expect.objectContaining({
          context: expect.objectContaining({
            matcher: 'greedy',
            batchSize: 2,
            distanceToSource: 4,
            altVehicleName: 'V2',
            altDistanceToSource: 6,
          }),
        }),
      );
    });

    it('dispatches the hungarian pairing and records the greedy counterfactual by default', async () => {
      delete process.env.DISPATCH_MATCHER;
      const { service, kernelApi, transportTask } = build();

      await service.run();

      expect(dispatchedVehicleFor(kernelApi, 1)).toBe('V2');
      expect(transportTask.changeStatus).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 't1' }),
        TaskStatus.PICKING_UP,
        expect.objectContaining({
          context: expect.objectContaining({
            matcher: 'hungarian',
            distanceToSource: 6,
            altVehicleName: 'V1',
            altDistanceToSource: 4,
          }),
        }),
      );
    });

    it('falls back to hungarian on an unrecognised value', async () => {
      process.env.DISPATCH_MATCHER = 'hungarain';
      const { service, kernelApi } = build();

      await service.run();

      expect(dispatchedVehicleFor(kernelApi, 1)).toBe('V2');
    });
  });

  describe('map scope', () => {
    it('dispatches nothing while the loaded map is unknown', async () => {
      const { service, taskRepo, kernelApi } = build(new Set(), null);

      await service.run();

      expect(taskRepo.find).not.toHaveBeenCalled();
      expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
    });

    it('reads tasks, busy tasks and vehicles of the loaded map only', async () => {
      const { service, taskRepo, agvRepo } = build();

      await service.run();

      expect(taskRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: TaskStatus.READY_TO_ASSIGN,
            mapRecordId: TEST_MAP_ID,
          },
        }),
      );
      expect(taskRepo.find).toHaveBeenCalledWith({
        where: [
          expect.objectContaining({ mapRecordId: TEST_MAP_ID }),
          expect.objectContaining({ mapRecordId: TEST_MAP_ID }),
        ],
      });
      expect(agvRepo.find).toHaveBeenCalledWith({
        where: { mapRecordId: TEST_MAP_ID },
      });
    });

    it('refuses to issue a pick-up for a cargo stamped with another map', async () => {
      const { service, cargos, kernelApi } = build();
      Object.assign(cargos.get('c1')!, { mapRecordId: 'another-map' });

      await service.run();

      const pickedUpLocations = kernelApi.createTransportOrder.mock.calls.map(
        (call: unknown[]) =>
          (call[1] as Array<{ locationName: string }>)[0].locationName,
      );
      expect(pickedUpLocations).not.toContain('LOC-1');
    });
  });
});
