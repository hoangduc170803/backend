import { TransportOrderService } from '../opentcs/transport-order.service';
import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { LaneSafetyService } from './lane-safety.service';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import type { ZoneMemberEntity } from '../zones/entities/zone-member.entity';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type { KernelVehicleState } from '../opentcs/domain/kernel-model';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { TransportTaskService } from './transport-task.service';
import { ZoneGeometryService, MemberAxes } from './zone-geometry.service';

const ZONE_ID = 'zone-pickup';
const NEW_CARGO_LOCATION = 'loc-B';

const AXES: ReadonlyArray<readonly [string, MemberAxes]> = [
  ['loc-A', { laneKey: 0, depthKey: 0 }],
  ['loc-B', { laneKey: 0, depthKey: 1000 }],
  ['loc-C', { laneKey: 0, depthKey: 2000 }],
  ['loc-E', { laneKey: 0, depthKey: 3000 }],
  ['loc-D', { laneKey: 1000, depthKey: 2000 }],
];

const POINTS: ReadonlyArray<readonly [string, string[]]> = [
  ['loc-A', ['P-A']],
  ['loc-B', ['P-B']],
  ['loc-C', ['P-C']],
  ['loc-E', ['P-E']],
  ['loc-D', ['P-D']],
];

const POINT_NAMES = new Map(POINTS);
const POINTS_BY_LANE = AXES.reduce((byLane, [locationName, axes]) => {
  const points = byLane.get(axes.laneKey) ?? new Set<string>();
  for (const point of POINT_NAMES.get(locationName) ?? []) points.add(point);
  return byLane.set(axes.laneKey, points);
}, new Map<number, Set<string>>());

const zone = (): ZoneEntity =>
  ({
    id: ZONE_ID,
    name: 'Pickup',
    members: AXES.map(
      ([locationName], index) =>
        ({ locationName, positionIndex: index }) as ZoneMemberEntity,
    ),
  }) as ZoneEntity;

const cargoAt = (id: string, locationName: string): CargoEntity =>
  ({
    id,
    sourceZoneId: ZONE_ID,
    sourcePickupLocationName: locationName,
    sourcePointName: `P-${locationName.slice(-1)}`,
    status: CargoStatus.ACTIVE,
  }) as CargoEntity;

const pickingUp = (
  id: string,
  cargoId: string,
  vehicleName: string,
): TransportTaskEntity =>
  ({
    id,
    cargoId,
    status: TaskStatus.PICKING_UP,
    metadata: {
      assignedVehicleName: vehicleName,
      pickupOrderName: `PICKUP-${id}`,
    },
    assignedAt: new Date(),
    startedAt: new Date(),
  }) as TransportTaskEntity;

const vehicleState = (
  name: string,
  allocatedResources: string[][],
): KernelVehicleState => ({
  name,
  state: 'EXECUTING',
  procState: 'PROCESSING_ORDER',
  integrationLevel: 'TO_BE_UTILIZED',
  energyLevel: 90,
  paused: false,
  currentPosition: null,
  allocatedResources,
});

interface SetupOptions {
  cargos?: CargoEntity[];
  tasks?: TransportTaskEntity[];
  storeAllocated?: Record<string, string[][]>;
  kernelAllocated?: Record<string, string[][]>;
  connected?: boolean;
}

function setup(options: SetupOptions = {}) {
  const storeAllocated = options.storeAllocated ?? {};
  const kernelAllocated = options.kernelAllocated ?? storeAllocated;

  const taskRepo = { find: jest.fn().mockResolvedValue(options.tasks ?? []) };
  const cargoRepo = { find: jest.fn().mockResolvedValue(options.cargos ?? []) };
  const zoneRepo = {
    findOne: jest.fn().mockResolvedValue(zone()),
    find: jest.fn().mockResolvedValue([zone()]),
  };
  const zoneGeometry = {
    laneIndexOf: jest.fn().mockResolvedValue({
      axesByLocation: new Map(AXES),
      pointsByLane: POINTS_BY_LANE,
    }),
  };
  const kernelApi = {
    withdrawTransportOrder: jest.fn().mockResolvedValue(undefined),
    getVehicleStates: jest
      .fn()
      .mockResolvedValue(
        Object.entries(kernelAllocated).map(([name, allocated]) =>
          vehicleState(name, allocated),
        ),
      ),
  };

  const storeStates = new Map<string, KernelVehicleState>(
    Object.entries(storeAllocated).map(([name, allocated]) => [
      name,
      vehicleState(name, allocated),
    ]),
  );
  const storeReads: string[] = [];
  const vehicleStore = new VehicleStateStore();
  vehicleStore.setConnected(options.connected ?? true);
  jest.spyOn(vehicleStore, 'get').mockImplementation((name: string) => {
    storeReads.push(name);
    return storeStates.get(name);
  });

  const transportTask = {
    changeStatus: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new LaneSafetyService(
    taskRepo as unknown as Repository<TransportTaskEntity>,
    cargoRepo as unknown as Repository<CargoEntity>,
    zoneRepo as unknown as Repository<ZoneEntity>,
    zoneGeometry as unknown as ZoneGeometryService,
    kernelApi as unknown as KernelApiService,
    new TransportOrderService(kernelApi as unknown as KernelApiService),
    vehicleStore,
    transportTask as unknown as TransportTaskService,
    { latestActiveOrder: jest.fn().mockResolvedValue(null) } as never,
  );

  return { svc, kernelApi, transportTask, taskRepo, storeReads };
}

describe('LaneSafetyService.clearLaneForNewCargo', () => {
  it('does nothing when the lane holds no PICKING_UP task', async () => {
    const { svc, kernelApi, transportTask } = setup({
      cargos: [cargoAt('c-C', 'loc-C')],
      tasks: [],
    });

    await svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION);

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('ignores a PICKING_UP task shallower than the new slot', async () => {
    const { svc, kernelApi, transportTask } = setup({
      cargos: [cargoAt('c-A', 'loc-A')],
      tasks: [pickingUp('t-A', 'c-A', 'V1')],
      storeAllocated: { V1: [['P-A']] },
    });

    await svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION);

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('ignores a deeper PICKING_UP task that sits in another lane', async () => {
    const { svc, kernelApi, transportTask } = setup({
      cargos: [cargoAt('c-D', 'loc-D')],
      tasks: [pickingUp('t-D', 'c-D', 'V1')],
      storeAllocated: { V1: [['P-D']] },
    });

    await svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION);

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('refuses the placement when the deeper vehicle already holds a lane point', async () => {
    const { svc, kernelApi, transportTask } = setup({
      cargos: [cargoAt('c-C', 'loc-C')],
      tasks: [pickingUp('t-C', 'c-C', 'V1')],
      storeAllocated: { V1: [['P-C', 'P-B --- P-C']] },
    });

    await expect(
      svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION),
    ).rejects.toThrow(/V1/);

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });

  it('preempts the deeper task when the vehicle is still outside the lane', async () => {
    const task = pickingUp('t-C', 'c-C', 'V1');
    const { svc, kernelApi, transportTask } = setup({
      cargos: [cargoAt('c-C', 'loc-C')],
      tasks: [task],
      storeAllocated: { V1: [['P-OUTSIDE', 'P-AISLE --- P-OUTSIDE']] },
    });

    await svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION);

    expect(kernelApi.withdrawTransportOrder).toHaveBeenCalledTimes(1);
    expect(kernelApi.withdrawTransportOrder).toHaveBeenCalledWith(
      'PICKUP-t-C',
      false,
    );
    expect(transportTask.changeStatus).toHaveBeenCalledTimes(1);
    const [changed, status, log] = transportTask.changeStatus.mock.calls[0] as [
      TransportTaskEntity,
      TaskStatus,
      { trigger: string; vehicleName: string | null; context: unknown },
    ];
    expect(status).toBe(TaskStatus.BLOCKED);
    expect(changed.metadata.pickupOrderName).toBeUndefined();
    expect(changed.metadata.assignedVehicleName).toBeUndefined();
    expect(changed.metadata.blockedReason).toBeDefined();
    expect(changed.assignedAt).toBeNull();
    expect(changed.startedAt).toBeNull();
    expect(log.trigger).toBe('CARGO_CREATE');
    expect(log.vehicleName).toBe('V1');
    expect(log.context).toEqual({
      preempted: true,
      withdrawnOrder: 'PICKUP-t-C',
    });
  });

  it('does not treat a path whose name embeds a lane point as reaching the lane', async () => {
    const { svc, kernelApi } = setup({
      cargos: [cargoAt('c-C', 'loc-C')],
      tasks: [pickingUp('t-C', 'c-C', 'V1')],
      storeAllocated: { V1: [['P-B --- P-C']] },
    });

    await svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION);

    expect(kernelApi.withdrawTransportOrder).toHaveBeenCalledWith(
      'PICKUP-t-C',
      false,
    );
  });

  it('reads the kernel instead of the store while SSE is disconnected', async () => {
    const { svc, kernelApi, storeReads } = setup({
      cargos: [cargoAt('c-C', 'loc-C')],
      tasks: [pickingUp('t-C', 'c-C', 'V1')],
      connected: false,
      storeAllocated: { V1: [] },
      kernelAllocated: { V1: [['P-C']] },
    });

    await expect(
      svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(kernelApi.getVehicleStates).toHaveBeenCalledTimes(1);
    expect(storeReads).toEqual([]);
  });

  it('leaves the task PICKING_UP when the withdraw call fails', async () => {
    const task = pickingUp('t-C', 'c-C', 'V1');
    const { svc, kernelApi, transportTask } = setup({
      cargos: [cargoAt('c-C', 'loc-C')],
      tasks: [task],
      storeAllocated: { V1: [['P-OUTSIDE']] },
    });
    kernelApi.withdrawTransportOrder.mockRejectedValue(
      new Error('kernel down'),
    );

    await expect(
      svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION),
    ).rejects.toThrow('kernel down');

    expect(transportTask.changeStatus).not.toHaveBeenCalled();
    expect(task.status).toBe(TaskStatus.PICKING_UP);
    expect(task.metadata.pickupOrderName).toBe('PICKUP-t-C');
    expect(task.metadata.assignedVehicleName).toBe('V1');
  });

  it('refuses every deeper task when a single vehicle already holds a lane point', async () => {
    const { svc, kernelApi, transportTask } = setup({
      cargos: [cargoAt('c-C', 'loc-C'), cargoAt('c-E', 'loc-E')],
      tasks: [pickingUp('t-C', 'c-C', 'V1'), pickingUp('t-E', 'c-E', 'V2')],
      storeAllocated: { V1: [['P-OUTSIDE']], V2: [['P-E']] },
    });

    await expect(
      svc.clearLaneForNewCargo(ZONE_ID, NEW_CARGO_LOCATION),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(kernelApi.withdrawTransportOrder).not.toHaveBeenCalled();
    expect(transportTask.changeStatus).not.toHaveBeenCalled();
  });
});
