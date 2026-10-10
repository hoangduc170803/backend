import { AssignmentEngineService } from './assignment-engine.service';
import { DispatchDistanceService } from './dispatch-distance.service';
import { VehicleCandidateService } from './vehicle-candidate.service';
import { PickupOrderService } from './pickup-order.service';
import { TransportOrderService } from '../opentcs/transport-order.service';
import { ParkClaimStore } from './park-claim.store';
import { TaskStatus } from './entities/transport-task.entity';
import {
  TEST_MAP_ID,
  fixedActiveMap,
} from '../maps/infrastructure/active-map-context.testing';

const stub = <T>(value: unknown): T => value as T;

const QUEUED_PARK_ORDER = 'PARK-V1-1002-queued';
const ATTACHED_PARK_ORDER = 'PARK-abc';

describe('AssignmentEngineService park orders', () => {
  function build() {
    const task = {
      id: 't1',
      cargoId: 'c1',
      mapRecordId: TEST_MAP_ID,
      status: TaskStatus.READY_TO_ASSIGN,
      metadata: {},
      createdAt: new Date(),
    };
    const cargo = {
      id: 'c1',
      sourcePickupLocationName: 'LOC-1',
      mapRecordId: TEST_MAP_ID,
      sourcePointName: null,
    };
    const parkingVehicle = {
      state: 'EXECUTING',
      procState: 'PROCESSING_ORDER',
      integrationLevel: 'TO_BE_UTILIZED',
      transportOrder: ATTACHED_PARK_ORDER,
      currentPosition: 'P1',
      energyLevel: 80,
    };

    const taskRepo = {
      find: jest
        .fn()
        .mockImplementation((opts: { where?: { status?: unknown } }) =>
          opts?.where?.status === TaskStatus.READY_TO_ASSIGN
            ? Promise.resolve([task])
            : Promise.resolve([]),
        ),
    };
    const cargoRepo = { findOne: jest.fn().mockResolvedValue(cargo) };
    const agvRepo = {
      find: jest.fn().mockResolvedValue([
        {
          name: 'V1',
          isDispatchEnabled: true,
          isIgnored: false,
          criticalBatteryThreshold: 20,
        },
      ]),
    };
    const kernelApi = {
      withdrawTransportOrder: jest.fn().mockResolvedValue(undefined),
      createTransportOrder: jest.fn().mockResolvedValue(undefined),
      getTransportOrders: jest.fn().mockResolvedValue([]),
      loadOperation: 'PICK_UP',
    };
    const vehicleStore = { get: jest.fn().mockReturnValue(parkingVehicle) };
    const parkClaims = new ParkClaimStore(
      stub(vehicleStore),
      stub(kernelApi),
      { openOrdersOn: () => Promise.resolve([]) } as never,
      { id: () => Promise.resolve('map-1') } as never,
    );
    const transportTask = {
      changeStatus: jest.fn().mockResolvedValue(undefined),
    };
    const pickupDependency = {
      isBlocked: jest.fn().mockResolvedValue(false),
      blockedTaskIds: jest.fn().mockResolvedValue(new Set()),
    };
    const routing = { getReverseRoadGraph: jest.fn().mockResolvedValue(null) };
    const dispatchPolicy = {
      getActiveWeights: jest.fn().mockResolvedValue(null),
    };
    const zoneRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const approachPoint = {
      feederPointsOf: jest.fn().mockResolvedValue([]),
    };
    const parkYield = { yieldVehicle: jest.fn().mockResolvedValue(undefined) };
    const svc = new AssignmentEngineService(
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
      fixedActiveMap(),
      stub(parkYield),
      stub({
        openRound: () =>
          Promise.resolve({ admit: () => Promise.resolve(true) }),
      }),
    );
    return {
      svc,
      kernelApi,
      transportTask,
      vehicleStore,
      parkClaims,
      parkYield,
    };
  }

  function makeIdle(vehicleStore: { get: jest.Mock }): void {
    vehicleStore.get.mockReturnValue({
      state: 'IDLE',
      procState: 'IDLE',
      integrationLevel: 'TO_BE_UTILIZED',
      transportOrder: null,
      currentPosition: 'P1',
      energyLevel: 80,
    });
  }

  it('cancels the park task of a vehicle en route to park before issuing its pickup', async () => {
    const { svc, kernelApi, transportTask, parkYield } = build();

    await svc.run();

    expect(parkYield.yieldVehicle).toHaveBeenCalledWith('V1', TEST_MAP_ID);
    expect(parkYield.yieldVehicle.mock.invocationCallOrder[0]).toBeLessThan(
      kernelApi.createTransportOrder.mock.invocationCallOrder[0],
    );
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
    expect(kernelApi.createTransportOrder).toHaveBeenCalledWith(
      expect.stringMatching(/^PICKUP-V1-LOC-1-/),
      [{ locationName: 'LOC-1', operation: 'PICK_UP' }],
      'V1',
      expect.objectContaining({ 'wes:leg': 'PICKUP' }),
      { dispensable: false },
    );
    expect(transportTask.changeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      TaskStatus.PICKING_UP,
      expect.anything(),
    );
  });

  it('also clears a queued park task of an idle vehicle before its pickup', async () => {
    const { svc, kernelApi, vehicleStore, parkYield } = build();
    makeIdle(vehicleStore);

    await svc.run();

    expect(parkYield.yieldVehicle).toHaveBeenCalledWith('V1', TEST_MAP_ID);
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
  });

  it('does not withdraw anything itself for a plain idle (non-parking) vehicle', async () => {
    const { svc, kernelApi, vehicleStore } = build();
    makeIdle(vehicleStore);

    await svc.run();

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
  });

  it('never looks up or withdraws kernel park orders itself', async () => {
    const { svc, kernelApi, vehicleStore, parkClaims } = build();
    makeIdle(vehicleStore);
    parkClaims.claim('V1', '1002', QUEUED_PARK_ORDER);

    await svc.run();

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(kernelApi.getTransportOrders).not.toHaveBeenCalled();
    expect(kernelApi.createTransportOrder).toHaveBeenCalledTimes(1);
  });

  it('leaves another vehicle claim alone while assigning', async () => {
    const { svc, parkClaims } = build();
    parkClaims.claim('V2', '1003', 'PARK-V2-1003-queued');

    await svc.run();

    expect(parkClaims.get('V2')).toEqual({
      point: '1003',
      orderName: 'PARK-V2-1003-queued',
    });
  });
});
