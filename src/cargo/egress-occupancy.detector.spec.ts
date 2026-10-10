import { EgressOccupancyDetector } from './egress-occupancy.detector';
import { CargoStatus } from './entities/cargo.entity';
import { TaskStatus } from './entities/transport-task.entity';

const ZONE_ID = 'zone-1';
const DEEP_SLOT = '3067';
const SHALLOW_SLOT = '3068';
const FIRST_EXIT = '3066';
const SECOND_EXIT = '3065';
const OUTSIDE = '0011';

function slot(name: string) {
  return { locationName: `location_${name}`, pointName: name };
}

const LAYOUT = {
  mainlinePoints: new Set<string>(),
  columns: [[slot(DEEP_SLOT), slot(SHALLOW_SLOT)]],
  lanes: [
    {
      axis: 40000,
      slots: [slot(DEEP_SLOT), slot(SHALLOW_SLOT)],
      axisPoints: [DEEP_SLOT, SHALLOW_SLOT, FIRST_EXIT, SECOND_EXIT],
      axisAlong: [0, 1000, 2000, 3000],
    },
  ],
  entryPoints: [],
  memberPointNames: new Set([DEEP_SLOT, SHALLOW_SLOT]),
  strandedLocationNames: [],
};

function vehicleAt(name: string, position: string | null) {
  return {
    name,
    state: 'EXECUTING',
    procState: 'PROCESSING_ORDER',
    integrationLevel: 'TO_BE_UTILIZED',
    energyLevel: 87,
    paused: false,
    currentPosition: position,
    precisePosition: { x: 41000, y: 24450, z: 0 },
    orientationAngle: -90,
    allocatedResources: [],
    transportOrder: 'DROPOFF-Vehicle-0008-location_3067-uuid',
    goal: {
      orderName: 'DROPOFF-Vehicle-0008-location_3067-uuid',
      destinationName: 'location_3067',
      operation: 'DROP_OFF',
    },
    properties: { 'fms:waitDropOff': 'false' },
    errors: { fatal: [], warning: [] },
    observedAt: '2026-08-24T10:00:00.000Z',
  };
}

function taskCarrying(unloaded = false) {
  return {
    id: 'task-1',
    requestCode: 'REQ-0001',
    status: TaskStatus.DELIVERING,
    cargoId: 'cargo-1',
    assignedAt: new Date('2026-08-24T09:58:00.000Z'),
    startedAt: new Date('2026-08-24T09:59:00.000Z'),
    metadata: {
      assignedVehicleName: 'Vehicle-0008',
      dropoffOrderName: 'DROPOFF-Vehicle-0008-location_3067-uuid',
      ...(unloaded ? { unloadedAt: '2026-08-24T10:00:00.000Z' } : {}),
    },
  };
}

const CARGO = {
  id: 'cargo-1',
  itemCode: 'ITEM-42',
  status: CargoStatus.ACTIVE,
  sourcePointName: '0104',
  sourcePickupLocationName: 'location_0104',
  destinationLocationName: `location_${DEEP_SLOT}`,
  reservedLocationName: `location_${DEEP_SLOT}`,
  slotDecisionSeq: 3,
  destinationZoneId: ZONE_ID,
  createdAt: new Date('2026-08-24T09:57:00.000Z'),
};

function makeDetector(options: { task?: unknown } = {}) {
  const task = options.task === undefined ? taskCarrying() : options.task;
  const fleet = new Map<string, ReturnType<typeof vehicleAt>>();

  function queryBuilder(): Record<string, jest.Mock> {
    const builder: Record<string, jest.Mock> = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      getOne: jest.fn().mockResolvedValue(task),
    };
    builder.where.mockReturnValue(builder);
    builder.andWhere.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    return builder;
  }

  const taskRepo = { createQueryBuilder: jest.fn(queryBuilder) };
  const cargoRepo = { findOne: jest.fn().mockResolvedValue(CARGO) };
  const zoneRepo = {
    findOne: jest.fn().mockResolvedValue({ id: ZONE_ID, name: 'tra hang 2' }),
  };
  const saved: Record<string, unknown>[] = [];
  let nextEventId = 100;
  const eventRepo = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn((row: Record<string, unknown>) => {
      const stored = { ...row, id: String(nextEventId++) };
      saved.push(stored);
      return Promise.resolve(stored);
    }),
    query: jest.fn().mockResolvedValue([{ dwell_ms: '4200' }]),
  };
  const vehicleStore = {
    getAll: jest.fn(() => [...fleet.values()]),
    vehicleUpdates: { subscribe: jest.fn() },
  };
  const deliverySlotEngine = { layoutFor: jest.fn().mockResolvedValue(LAYOUT) };
  const kernelApi = {
    getPlantModelView: jest.fn().mockResolvedValue({
      points: [],
      paths: [
        {
          srcPointName: SHALLOW_SLOT,
          destPointName: OUTSIDE,
          maxVelocity: 1000,
          maxReverseVelocity: 0,
        },
      ],
    }),
  };

  const detector = new EgressOccupancyDetector(
    taskRepo as never,
    cargoRepo as never,
    zoneRepo as never,
    eventRepo as never,
    vehicleStore as never,
    deliverySlotEngine as never,
    kernelApi as never,
    { id: jest.fn().mockResolvedValue('map-a') } as never,
  );
  const logger = (detector as unknown as { logger: Record<string, jest.Mock> })
    .logger;
  logger.log = jest.fn();
  logger.warn = jest.fn();
  logger.error = jest.fn();

  async function move(position: string | null, name = 'Vehicle-0008') {
    const state = vehicleAt(name, position);
    fleet.set(name, state);
    detector.onVehicleUpdate(state as never);
    await detector.settled();
  }

  return { detector, logger, eventRepo, saved, move, taskRepo };
}

function loggedLines(entries: jest.Mock): string {
  return entries.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('EgressOccupancyDetector', () => {
  it('records a row when a loaded vehicle arrives on a lane exit cell', async () => {
    const { saved, move } = makeDetector();
    await move(FIRST_EXIT);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      vehicleName: 'Vehicle-0008',
      pointName: FIRST_EXIT,
      egressKind: 'lane exit',
      laneIndexes: [0],
      cellsOutOfLane: 1,
      zoneName: 'tra hang 2',
      requestCode: 'REQ-0001',
      cargoId: 'cargo-1',
      itemCode: 'ITEM-42',
    });
  });

  it('keeps everything else it had at that moment in the snapshot', async () => {
    const { saved, move } = makeDetector();
    await move(FIRST_EXIT);

    const snapshot = saved[0].snapshot as Record<string, unknown>;
    expect(snapshot.vehicle).toMatchObject({ currentPosition: FIRST_EXIT });
    expect(snapshot.cargo).toMatchObject({ itemCode: 'ITEM-42' });
    expect(snapshot.task).toMatchObject({ requestCode: 'REQ-0001' });
    expect(snapshot.lanes).toEqual([
      {
        index: 0,
        axis: 40000,
        slots: [DEEP_SLOT, SHALLOW_SLOT],
        axisPoints: [DEEP_SLOT, SHALLOW_SLOT, FIRST_EXIT, SECOND_EXIT],
      },
    ]);
    expect(snapshot.fleetOnTheseLanes).toEqual([
      { vehicleName: 'Vehicle-0008', pointName: FIRST_EXIT },
    ]);
  });

  it('writes nothing while the vehicle is still on its own drop slot', async () => {
    const { saved, move } = makeDetector();
    await move(DEEP_SLOT);

    expect(saved).toHaveLength(0);
  });

  it('writes nothing once the cargo has been unloaded', async () => {
    const { saved, move } = makeDetector({ task: null });
    await move(FIRST_EXIT);

    expect(saved).toHaveLength(0);
  });

  it('does not write again while the position stays the same', async () => {
    const { saved, move } = makeDetector();
    await move(FIRST_EXIT);
    await move(FIRST_EXIT);
    await move(FIRST_EXIT);

    expect(saved).toHaveLength(1);
  });

  it('closes the row with a dwell once the vehicle moves off', async () => {
    const { saved, eventRepo, logger, move } = makeDetector();
    await move(FIRST_EXIT);
    await move(DEEP_SLOT);

    expect(eventRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('SET "left_at" = now()'),
      [saved[0].id],
    );
    expect(loggedLines(logger.log)).toContain(
      'moved off the egress cell 3066 after 4.2s',
    );
  });

  it('opens a new row when the vehicle steps to the next egress cell', async () => {
    const { saved, move } = makeDetector();
    await move(FIRST_EXIT);
    await move(SECOND_EXIT);

    expect(saved.map((row) => row.pointName)).toEqual([
      FIRST_EXIT,
      SECOND_EXIT,
    ]);
  });

  it('counts the cell traffic leaves the zone through', async () => {
    const { saved, move } = makeDetector();
    await move(OUTSIDE);

    expect(saved[0]).toMatchObject({
      pointName: OUTSIDE,
      egressKind: 'zone exit',
    });
  });

  it('keeps running when a write fails', async () => {
    const { detector, logger, move } = makeDetector();
    (
      detector as unknown as { cargoRepo: { findOne: jest.Mock } }
    ).cargoRepo.findOne.mockRejectedValue(new Error('database is down'));

    await move(FIRST_EXIT);

    expect(loggedLines(logger.error)).toContain('database is down');
  });
});
