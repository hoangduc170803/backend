import { TransportOrderService } from '../opentcs/transport-order.service';
import type { Repository } from 'typeorm';
import { ChargeEngineService } from './charge-engine.service';
import { ParkClaimStore } from './park-claim.store';
import { buildRoadGraph } from './domain/routing';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { RoutingService } from './routing.service';
import { TransportTaskEntity } from './entities/transport-task.entity';
import type { AgvEntity } from '../agvs/entities/agv.entity';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';
import { directTasksIssuingThrough } from './direct-task.testing';
import { ChargeSlotReservationStore } from './charge-slot-reservation.store';
import { TaskOrderEntity } from './entities/task-order.entity';

const agv = (name: string, overrides: Partial<AgvEntity> = {}): AgvEntity =>
  ({
    name,
    isDispatchEnabled: true,
    isIgnored: false,
    criticalBatteryThreshold: 20,
    goodBatteryThreshold: 50,
    sufficientBatteryThreshold: 40,
    fullBatteryThreshold: 95,
    ...overrides,
  }) as AgvEntity;

const flat = (name: string, position: string): KernelVehicleState => ({
  name,
  state: 'IDLE',
  procState: 'IDLE',
  integrationLevel: 'TO_BE_UTILIZED',
  energyLevel: 10,
  paused: false,
  currentPosition: position,
  transportOrder: null,
});

const charging = (name: string, position: string): KernelVehicleState => ({
  ...flat(name, position),
  state: 'CHARGING',
  energyLevel: 30,
});

const twoWay = (from: string, to: string, length: number) => ({
  from,
  to,
  length,
  maxVelocity: 1,
  maxReverseVelocity: 1,
});

const graph = buildRoadGraph([
  twoWay('P1', 'C1', 1),
  twoWay('P1', 'PARK-1', 1),
  twoWay('PARK-1', 'PARK-2', 1),
]);

async function setup(
  states: KernelVehicleState[],
  options: {
    kernelUnreachable?: boolean;
    agvs?: AgvEntity[];
    pendingWork?: number;
    liveChargeTasks?: Partial<TransportTaskEntity>[];
    chargeOrders?: Partial<TaskOrderEntity>[];
  } = {},
) {
  const taskRepo = {
    find: jest.fn().mockResolvedValue(options.liveChargeTasks ?? []),
    count: jest.fn().mockResolvedValue(options.pendingWork ?? 0),
  };
  const taskOrderRepo = {
    find: jest.fn().mockResolvedValue(options.chargeOrders ?? []),
  };
  const agvRepo = {
    find: jest.fn().mockResolvedValue(options.agvs ?? [agv('V1')]),
  };
  const kernelApi = {
    getChargeLocations: jest
      .fn()
      .mockResolvedValue([{ name: 'CHG-1', points: ['C1'] }]),
    getParkingPoints: jest.fn().mockResolvedValue([
      { name: 'PARK-1', priority: null },
      { name: 'PARK-2', priority: null },
    ]),
    getTransportOrderState: jest.fn().mockResolvedValue('BEING_PROCESSED'),
    createTransportOrder: jest.fn().mockResolvedValue({
      name: 'created',
      state: 'RAW',
      destinations: [],
    }),
    sendInstantAction: jest.fn().mockResolvedValue(undefined),
    chargeOperation: 'startCharging',
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
  const reservations = new ChargeSlotReservationStore();

  const svc = new ChargeEngineService(
    taskRepo as unknown as Repository<TransportTaskEntity>,
    agvRepo as unknown as Repository<AgvEntity>,
    taskOrderRepo as unknown as Repository<TaskOrderEntity>,
    kernelApi as unknown as KernelApiService,
    directTasksIssuingThrough(
      new TransportOrderService(kernelApi as unknown as KernelApiService),
    ),
    vehicleStore,
    routing as unknown as RoutingService,
    parkClaims,
    fixedActiveMap(),
    reservations,
  );
  return { svc, kernelApi, parkClaims, reservations, vehicleStore };
}

function orderDestination(createOrder: jest.Mock): string {
  const destinations = createOrder.mock.calls[0][1] as {
    locationName: string;
  }[];
  return destinations[0].locationName;
}

describe('ChargeEngineService', () => {
  it('charges a flat vehicle even when the park claim ledger is unavailable', async () => {
    const { svc, kernelApi } = await setup([flat('V1', 'P1')], {
      kernelUnreachable: true,
    });

    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      expect.stringMatching(/^CHARGE-V1-CHG-1-/),
      [{ locationName: 'CHG-1', operation: 'startCharging' }],
      'V1',
      { 'wes:leg': 'CHARGE' },
      { dispensable: false },
    );
  });

  it('charges a flat vehicle that has been taken off dispatch', async () => {
    const { svc, kernelApi } = await setup([flat('V1', 'P1')], {
      agvs: [agv('V1', { isDispatchEnabled: false })],
    });

    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      expect.stringMatching(/^CHARGE-V1-CHG-1-/),
      [{ locationName: 'CHG-1', operation: 'startCharging' }],
      'V1',
      { 'wes:leg': 'CHARGE' },
      { dispensable: false },
    );
  });

  it('leaves an ignored vehicle flat — BR-06 excludes it from forced charging', async () => {
    const { svc, kernelApi } = await setup([flat('V1', 'P1')], {
      agvs: [agv('V1', { isIgnored: true })],
    });

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('skips the no-slot park fallback while the park claim ledger is unavailable', async () => {
    const { svc, kernelApi } = await setup(
      [flat('V1', 'P1'), charging('V9', 'C1')],
      { kernelUnreachable: true },
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('parks a vehicle that finds no charge slot and records the claim', async () => {
    const { svc, kernelApi, parkClaims } = await setup([
      flat('V1', 'P1'),
      charging('V9', 'C1'),
    ]);

    await svc.run();

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

  it('does not stack a park order on a vehicle that already holds a claim', async () => {
    const { svc, kernelApi, parkClaims } = await setup([
      flat('V1', 'P1'),
      charging('V9', 'C1'),
    ]);
    parkClaims.claim('V1', 'PARK-1', 'PARK-V1-PARK-1-existing');

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('keeps the fallback off a park point another vehicle is already driving to', async () => {
    const enRoute: KernelVehicleState = {
      ...charging('V2', 'P1'),
      state: 'IDLE',
      procState: 'PROCESSING_ORDER',
      transportOrder: 'PARK-V2-PARK-1-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5',
    };
    const { svc, kernelApi } = await setup([
      flat('V1', 'P1'),
      charging('V9', 'C1'),
      enRoute,
    ]);

    await svc.run();

    expect(orderDestination(kernelApi.createTransportOrder)).toBe('PARK-2');
  });

  it('keeps the fallback off a park point another vehicle has claimed', async () => {
    const { svc, kernelApi, parkClaims } = await setup([
      flat('V1', 'P1'),
      charging('V9', 'C1'),
    ]);
    parkClaims.claim('V2', 'PARK-1', 'PARK-V2-PARK-1-existing');

    await svc.run();

    expect(orderDestination(kernelApi.createTransportOrder)).toBe('PARK-2');
  });

  it('redirects a critical vehicle that is driving to a park point (BR-14)', async () => {
    const parking: KernelVehicleState = {
      ...flat('V1', 'P1'),
      procState: 'PROCESSING_ORDER',
      transportOrder: 'PARK-V1-PARK-1-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5',
    };
    const { svc, kernelApi } = await setup([parking]);

    await svc.run();

    expect(orderDestination(kernelApi.createTransportOrder)).toBe('CHG-1');
  });

  it('asks a charging vehicle at or above sufficient to yield its slot, then sends the critical one', async () => {
    const donor = { ...charging('V9', 'C1'), energyLevel: 70 };
    const { svc, kernelApi, reservations, vehicleStore } = await setup(
      [flat('V1', 'P1'), donor],
      { agvs: [agv('V1'), agv('V9')] },
    );

    await svc.run();

    expect(kernelApi.sendInstantAction).toHaveBeenCalledWith(
      'V9',
      'stopCharging',
    );
    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
    expect(reservations.reservedPoints()).toEqual(new Set(['C1']));

    vehicleStore.set('V9', { ...donor, state: 'IDLE', currentPosition: 'P1' });
    await svc.run();

    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      expect.stringMatching(/^CHARGE-V1-CHG-1-/),
      [{ locationName: 'CHG-1', operation: 'startCharging' }],
      'V1',
      { 'wes:leg': 'CHARGE' },
      { dispensable: false },
    );
    expect(reservations.all()).toEqual([]);
  });

  it('charges an idle vehicle below good when there is no waiting work', async () => {
    const { svc, kernelApi } = await setup([
      { ...flat('V1', 'P1'), energyLevel: 40 },
    ]);

    await svc.run();

    expect(orderDestination(kernelApi.createTransportOrder)).toBe('CHG-1');
  });

  it('keeps a vehicle below good available while cargo work is waiting', async () => {
    const { svc, kernelApi } = await setup(
      [{ ...flat('V1', 'P1'), energyLevel: 40 }],
      { pendingWork: 1 },
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('does not charge an idle vehicle at or above good', async () => {
    const { svc, kernelApi } = await setup([
      { ...flat('V1', 'P1'), energyLevel: 50 },
    ]);

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalled();
  });

  it('stops charging at the per-vehicle full threshold', async () => {
    const { svc, kernelApi } = await setup(
      [{ ...charging('V1', 'C1'), energyLevel: 95 }],
      { agvs: [agv('V1')] },
    );

    await svc.run();

    expect(kernelApi.sendInstantAction).toHaveBeenCalledWith(
      'V1',
      'stopCharging',
    );
  });

  it('counts a charge order it did not issue itself as holding the slot', async () => {
    const enRoute: KernelVehicleState = {
      ...flat('V2', 'P1'),
      energyLevel: 60,
      procState: 'PROCESSING_ORDER',
      transportOrder: 'CHARGE-V2-CHG-1-0d4dd3a5-bfe5-4d90-8893-31ed8d12cae5',
    };
    const { svc, kernelApi } = await setup([flat('V1', 'P1'), enRoute], {
      agvs: [agv('V1'), agv('V2')],
    });

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalledWith(
      expect.stringMatching(/^CHARGE-V1-/),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('counts a charge order recorded in the database but not yet picked up by the kernel', async () => {
    const { svc, kernelApi } = await setup(
      [flat('V1', 'P1'), { ...flat('V2', 'P1'), energyLevel: 60 }],
      {
        agvs: [agv('V1'), agv('V2')],
        liveChargeTasks: [
          { id: 'task-v2', metadata: { assignedVehicleName: 'V2' } },
        ],
        chargeOrders: [
          {
            taskId: 'task-v2',
            destinations: [
              { locationName: 'CHG-1', operation: 'startCharging' },
            ],
          },
        ],
      },
    );

    await svc.run();

    expect(kernelApi.createTransportOrder).not.toHaveBeenCalledWith(
      expect.stringMatching(/^CHARGE-V1-/),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('never sends two vehicles to the only free slot in one pass', async () => {
    const { svc, kernelApi } = await setup(
      [flat('V1', 'P1'), flat('V2', 'P1')],
      { agvs: [agv('V1'), agv('V2')] },
    );

    await svc.run();

    const chargeOrders = kernelApi.createTransportOrder.mock.calls.filter(
      ([name]: [string]) => name.startsWith('CHARGE-'),
    );
    expect(chargeOrders).toHaveLength(1);
  });
});
