import { TransportOrderService } from '../opentcs/transport-order.service';
import { In, type Repository } from 'typeorm';
import { ParkingEngineService } from './parking-engine.service';
import { ChargeSlotReservationStore } from './charge-slot-reservation.store';
import { ParkClaimStore } from './park-claim.store';
import { buildRoadGraph } from './domain/routing';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { RoutingService } from './routing.service';
import {
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import type { AgvEntity } from '../agvs/entities/agv.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../maps/infrastructure/active-map-context.testing';
import { directTasksIssuingThrough } from './direct-task.testing';

const agv = (name: string, overrides: Partial<AgvEntity> = {}): AgvEntity =>
  ({
    name,
    isDispatchEnabled: true,
    isIgnored: false,
    ...overrides,
  }) as AgvEntity;

const idleAt = (name: string, position: string): KernelVehicleState => ({
  name,
  state: 'IDLE',
  procState: 'IDLE',
  integrationLevel: 'TO_BE_UTILIZED',
  energyLevel: 100,
  paused: false,
  currentPosition: position,
  transportOrder: null,
});

const parkOrderName = (vehicle: string, destination: string) =>
  `PARK-${vehicle}-${destination}-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5`;

const twoWay = (from: string, to: string, length: number) => ({
  from,
  to,
  length,
  maxVelocity: 1,
  maxReverseVelocity: 1,
});

const graph = buildRoadGraph([
  twoWay('P1', 'PARK-1', 1),
  twoWay('P3', 'PARK-1', 1),
  twoWay('PARK-1', 'PARK-2', 1),
  twoWay('PARK-2', 'P2', 1),
]);

interface SetupOptions {
  kernelUnreachable?: boolean;
  zonePoints?: string[];
}

async function setup(
  states: KernelVehicleState[],
  agvs: AgvEntity[],
  options: SetupOptions = {},
) {
  const taskRepo = {
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
  };
  const agvRepo = { find: jest.fn().mockResolvedValue(agvs) };
  const kernelApi = {
    getParkingPoints: jest.fn().mockResolvedValue([
      { name: 'PARK-1', priority: null },
      { name: 'PARK-2', priority: null },
    ]),
    getChargeLocations: jest.fn().mockResolvedValue([]),
    getTransportOrderState: jest.fn().mockResolvedValue('BEING_PROCESSED'),
    createTransportOrder: jest.fn().mockResolvedValue({
      name: 'created',
      state: 'RAW',
      destinations: [],
    }),
  };
  const routing = { getRoadGraph: jest.fn().mockResolvedValue(graph) };

  const vehicleStore = new VehicleStateStore();
  for (const state of states) vehicleStore.set(state.name, state);

  const parkClaims = new ParkClaimStore(
    vehicleStore,
    kernelApi as unknown as KernelApiService,
    {
      openOrdersOn: options.kernelUnreachable
        ? () => Promise.reject(new Error('ledger unreadable'))
        : () => Promise.resolve([]),
    } as never,
    { id: () => Promise.resolve('map-1') } as never,
  );
  await parkClaims.onApplicationBootstrap();

  const svc = new ParkingEngineService(
    taskRepo as unknown as Repository<TransportTaskEntity>,
    agvRepo as unknown as Repository<AgvEntity>,
    kernelApi as unknown as KernelApiService,
    directTasksIssuingThrough(
      new TransportOrderService(kernelApi as unknown as KernelApiService),
    ),
    vehicleStore,
    routing as unknown as RoutingService,
    parkClaims,
    fixedActiveMap(),
    new ChargeSlotReservationStore(),
    {
      find: jest
        .fn()
        .mockResolvedValue(options.zonePoints ? [{ id: 'z1' }] : []),
    } as never,
    {
      blockingPointsOf: jest
        .fn()
        .mockResolvedValue(new Set(options.zonePoints ?? [])),
    } as never,
  );
  return { svc, taskRepo, kernelApi, vehicleStore, parkClaims };
}

function parkDestination(createOrder: jest.Mock, index = 0): string {
  const destinations = createOrder.mock.calls[index][1] as {
    locationName: string;
  }[];
  return destinations[0].locationName;
}

describe('ParkingEngineService', () => {
  it('parks an idle vehicle on the first cycle that sees it', async () => {
    const { svc, kernelApi, parkClaims } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1')],
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      expect.stringMatching(/^PARK-V1-PARK-1-/),
      [{ locationName: 'PARK-1', operation: 'MOVE' }],
      'V1',
      { 'wes:leg': 'PARK' },
      { dispensable: true },
    );
    expect(parkClaims.get('V1')).toEqual({
      point: 'PARK-1',
      orderName: kernelApi.createTransportOrder.mock.calls[0][0],
    });
  });

  it('claims nothing when the park order cannot be created', async () => {
    const { svc, kernelApi, parkClaims } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1')],
    );
    kernelApi.createTransportOrder.mockRejectedValue(new Error('kernel down'));

    await svc.run();

    expect(parkClaims.claimedVehicles()).toEqual(new Set());
    expect(parkClaims.claimedPoints()).toEqual(new Set());
  });

  it('does not park while cargo work is ready to assign', async () => {
    const { svc, taskRepo, kernelApi } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1')],
    );
    taskRepo.count.mockResolvedValue(1);

    await svc.run();

    expect(taskRepo.count).toHaveBeenCalledWith({
      where: {
        status: In([TaskStatus.READY_TO_ASSIGN]),
        mapRecordId: TEST_MAP_ID,
      },
    });
    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('parks a vehicle taken off dispatch even while cargo waits — it can never take that work', async () => {
    const { svc, taskRepo, kernelApi } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1', { isDispatchEnabled: false })],
    );
    taskRepo.count.mockResolvedValue(1);

    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      expect.stringMatching(/^PARK-V1-PARK-1-/),
      [{ locationName: 'PARK-1', operation: 'MOVE' }],
      'V1',
      { 'wes:leg': 'PARK' },
      { dispensable: true },
    );
  });

  it('leaves an ignored vehicle where it stands — BR-06 excludes it from parking', async () => {
    const { svc, kernelApi } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1', { isIgnored: true })],
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('does not re-park a vehicle already standing on a park point', async () => {
    const { svc, kernelApi } = await setup(
      [idleAt('V1', 'PARK-1')],
      [agv('V1')],
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('sends two ready vehicles to two distinct park points (in one cycle)', async () => {
    const { svc, kernelApi } = await setup(
      [idleAt('V1', 'P1'), idleAt('V2', 'P2')],
      [agv('V1'), agv('V2')],
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(2);
    expect(
      new Set([
        parkDestination(kernelApi.createTransportOrder, 0),
        parkDestination(kernelApi.createTransportOrder, 1),
      ]).size,
    ).toBe(2);
  });

  it('reads the target point out of another vehicle park order name', async () => {
    const enRoute: KernelVehicleState = {
      ...idleAt('V2', 'P2'),
      procState: 'PROCESSING_ORDER',
      transportOrder: `PARK-V2-PARK-1-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5`,
    };
    const { svc, kernelApi } = await setup(
      [idleAt('V1', 'P1'), enRoute],
      [agv('V1'), agv('V2')],
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
    expect(parkDestination(kernelApi.createTransportOrder)).toBe('PARK-2');
  });

  it('sees a vehicle standing on a park point even without an agv row', async () => {
    const { svc, kernelApi } = await setup(
      [idleAt('V1', 'P1'), idleAt('UNREGISTERED', 'PARK-1')],
      [agv('V1')],
    );

    await svc.run();

    expect(parkDestination(kernelApi.createTransportOrder)).toBe('PARK-2');
  });

  it('does not stack a second park order on a vehicle that already has one', async () => {
    const { svc, kernelApi, parkClaims } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1')],
    );
    parkClaims.claim('V1', 'PARK-1', parkOrderName('V1', 'PARK-1'));

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('excludes the point of an existing claim from the same pass', async () => {
    const { svc, kernelApi, parkClaims } = await setup(
      [idleAt('V1', 'P1'), idleAt('V2', 'P3')],
      [agv('V1'), agv('V2')],
    );
    parkClaims.claim('V1', 'PARK-1', parkOrderName('V1', 'PARK-1'));

    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      expect.stringMatching(/^PARK-V2-PARK-2-/),
      [{ locationName: 'PARK-2', operation: 'MOVE' }],
      'V2',
      { 'wes:leg': 'PARK' },
      { dispensable: true },
    );
  });

  it('excludes a point claimed by a vehicle the candidate loop never sees', async () => {
    const { svc, kernelApi, parkClaims } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1')],
    );
    parkClaims.claim(
      'CHARGE-PARKED',
      'PARK-1',
      parkOrderName('CHARGE-PARKED', 'PARK-1'),
    );

    await svc.run();

    expect(parkDestination(kernelApi.createTransportOrder)).toBe('PARK-2');
  });

  it('fails closed and parks nobody while the claim ledger is unrehydrated', async () => {
    const { svc, kernelApi } = await setup([idleAt('V1', 'P1')], [agv('V1')], {
      kernelUnreachable: true,
    });

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('keeps an in-flight park point out of the pool for a later vehicle (cross-cycle)', async () => {
    const { svc, kernelApi, vehicleStore } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1'), agv('V2')],
    );

    await svc.run();
    expect(parkDestination(kernelApi.createTransportOrder)).toBe('PARK-1');

    vehicleStore.set('V2', idleAt('V2', 'P3'));
    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(2);
    expect(parkDestination(kernelApi.createTransportOrder, 1)).toBe('PARK-2');
  });

  it('moves an idle vehicle out of a zone lane even while cargo work waits', async () => {
    const { svc, taskRepo, kernelApi } = await setup(
      [idleAt('V1', 'P1')],
      [agv('V1')],
      { zonePoints: ['P1'] },
    );
    taskRepo.count.mockResolvedValue(1);

    await svc.run();

    expect(parkDestination(kernelApi.createTransportOrder)).toBe('PARK-1');
  });
});
