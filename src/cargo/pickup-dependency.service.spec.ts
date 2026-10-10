import { PickupDependencyService } from './pickup-dependency.service';
import { TaskStatus } from './entities/transport-task.entity';
import { fixedActiveMap } from '../maps/infrastructure/active-map-context.testing';

const OUTER = 'location_0100';
const INNER = 'location_0101';
const LANE_POINTS = new Set(['P-OUTER', 'P-INNER']);

const AXES = new Map([
  [OUTER, { laneKey: 0, depthKey: 1000 }],
  [INNER, { laneKey: 0, depthKey: 2000 }],
]);

function task(
  id: string,
  cargoId: string,
  status: TaskStatus = TaskStatus.CREATED,
  vehicleName?: string,
) {
  return {
    id,
    cargoId,
    status,
    metadata: vehicleName ? { assignedVehicleName: vehicleName } : {},
  } as never;
}

interface Options {
  hasGeometry?: boolean;
  outerStatus?: TaskStatus;
  outerVehicle?: string;
  allocated?: Record<string, string[][]>;
}

function makeService(options: Options = {}) {
  const tasks = [
    task(
      't-outer',
      'c-outer',
      options.outerStatus ?? TaskStatus.CREATED,
      options.outerVehicle,
    ),
    task('t-inner', 'c-inner'),
  ];
  const cargos = [
    { id: 'c-outer', sourceZoneId: 'zone-1', sourcePickupLocationName: OUTER },
    { id: 'c-inner', sourceZoneId: 'zone-1', sourcePickupLocationName: INNER },
  ];
  const taskRepo = { find: jest.fn().mockResolvedValue(tasks) };
  const cargoRepo = { find: jest.fn().mockResolvedValue(cargos) };
  const zoneRepo = {
    find: jest.fn().mockResolvedValue([{ id: 'zone-1', name: 'khu a' }]),
  };
  const zoneGeometry = {
    laneIndexOf: jest
      .fn()
      .mockResolvedValue(
        options.hasGeometry === false
          ? null
          : { axesByLocation: AXES, pointsByLane: new Map([[0, LANE_POINTS]]) },
      ),
  };
  const allocated = options.allocated ?? {};
  const vehicleStore = {
    get: jest.fn((name: string) =>
      name in allocated
        ? { name, allocatedResources: allocated[name] }
        : undefined,
    ),
  };
  return new PickupDependencyService(
    taskRepo as never,
    cargoRepo as never,
    zoneRepo as never,
    zoneGeometry as never,
    vehicleStore as never,
    fixedActiveMap(),
  );
}

const blockedOf = async (options: Options = {}) => {
  const decisions = await makeService(options).evaluate();
  return {
    decisions,
    inner: decisions.find((d) => d.task.id === 't-inner'),
    outer: decisions.find((d) => d.task.id === 't-outer'),
  };
};

describe('PickupDependencyService', () => {
  it('blocks the inner cargo while the outer one is still at its source', async () => {
    const { inner, outer } = await blockedOf();

    expect(inner?.blocked).toBe(true);
    expect(outer?.blocked).toBe(false);
  });

  it('holds every task in the zone when the geometry cannot be computed', async () => {
    const { decisions } = await blockedOf({ hasGeometry: false });

    expect(decisions).toHaveLength(0);
  });

  it('keeps the inner cargo blocked while the outer vehicle is still in the column', async () => {
    const { inner } = await blockedOf({
      outerStatus: TaskStatus.DELIVERING,
      outerVehicle: 'V1',
      allocated: { V1: [['P-OUTER', 'P-OUTER --- P-AISLE']] },
    });

    expect(inner?.blocked).toBe(true);
    expect(inner?.reason).toContain('V1');
  });

  it('releases the inner cargo once that vehicle holds a point outside the column', async () => {
    const { inner } = await blockedOf({
      outerStatus: TaskStatus.DELIVERING,
      outerVehicle: 'V1',
      allocated: { V1: [['P-OUTER', 'P-AISLE']] },
    });

    expect(inner?.blocked).toBe(false);
  });

  it('holds the lane when the kernel has no state for the outer vehicle', async () => {
    const { inner } = await blockedOf({
      outerStatus: TaskStatus.DELIVERING,
      outerVehicle: 'V1',
      allocated: {},
    });

    expect(inner?.blocked).toBe(true);
  });

  it('holds the lane when the task past its source has no assigned vehicle', async () => {
    const { inner } = await blockedOf({ outerStatus: TaskStatus.DELIVERING });

    expect(inner?.blocked).toBe(true);
  });

  it('does not decide anything for a task that is past its source point', async () => {
    const { outer } = await blockedOf({
      outerStatus: TaskStatus.DELIVERING,
      outerVehicle: 'V1',
      allocated: { V1: [['P-AISLE']] },
    });

    expect(outer).toBeUndefined();
  });
});
