import { RetreatPointService } from './retreat-point.service';
import { CargoStatus } from './entities/cargo.entity';

const LANE_X = 46000;
const NEXT_LANE_X = 47000;
const CORRIDOR_X = 48000;
const ZONE = { id: 'zone-1', name: 'zone_1' } as never;

const point = (name: string, x: number, y: number) => ({
  name,
  type: 'HALT_POSITION',
  position: { x, y },
  parkingPriority: null,
});

const path = (
  srcPointName: string,
  destPointName: string,
  maxReverseVelocity = 10000,
) => ({
  srcPointName,
  destPointName,
  length: 1000,
  maxVelocity: 10000,
  maxReverseVelocity,
  locked: false,
});

const plantModel = {
  points: [
    point('corr', LANE_X, 0),
    point('A1', LANE_X, -1000),
    point('A2', LANE_X, -2000),
    point('A3', LANE_X, -3000),
    point('corrB', NEXT_LANE_X, 0),
    point('B1', NEXT_LANE_X, -1000),
    point('corrC', CORRIDOR_X, 0),
    point('C1', CORRIDOR_X, -1000),
  ],
  paths: [
    path('corr', 'A1'),
    path('A1', 'A2'),
    path('A2', 'A3'),
    path('corrB', 'B1'),
    path('A1', 'B1', 0),
    path('B1', 'C1', 0),
    path('corr', 'corrB', 0),
    path('corrB', 'corrC', 0),
  ],
  locationTypes: [],
  locations: [],
};

const slot = (pointName: string) => ({
  locationName: `location_${pointName}`,
  pointName,
});

const layout = {
  memberPointNames: new Set(['A1', 'A2', 'A3', 'B1']),
  lanes: [
    {
      axis: LANE_X,
      slots: [slot('A3'), slot('A2'), slot('A1')],
      axisPoints: ['A3', 'A2', 'A1', 'corr'],
    },
    {
      axis: NEXT_LANE_X,
      slots: [slot('B1')],
      axisPoints: ['B1', 'corrB'],
    },
  ],
};

function setup(
  overrides: {
    kernelApi?: Record<string, unknown>;
    layout?: unknown;
    occupied?: string[];
  } = {},
) {
  const kernelApi = {
    findPointForLocation: jest.fn().mockResolvedValue('A3'),
    getPlantModelView: jest.fn().mockResolvedValue(plantModel),
    ...overrides.kernelApi,
  };
  const deliverySlotEngine = {
    layoutFor: jest
      .fn()
      .mockResolvedValue(
        overrides.layout === undefined ? layout : overrides.layout,
      ),
  };
  const cargoRepo = {
    find: jest.fn().mockResolvedValue(
      (overrides.occupied ?? []).map((locationName) => ({
        destinationLocationName: locationName,
        destinationZoneId: 'zone-1',
        status: CargoStatus.DELIVERED,
      })),
    ),
  };
  const service = new RetreatPointService(
    kernelApi as never,
    deliverySlotEngine as never,
    cargoRepo as never,
  );
  return { service, kernelApi, deliverySlotEngine, cargoRepo };
}

describe('RetreatPointService.planFor', () => {
  it('turns across the next lane until it is out of the zone', async () => {
    const { service, kernelApi } = setup();

    expect(await service.planFor('location_A3', ZONE)).toEqual({
      cells: ['A2', 'A1'],
      egress: 'C1',
    });
    expect(kernelApi.findPointForLocation).toHaveBeenCalledWith('location_A3');
  });

  it('backs one cell further when the lane it must cross holds cargo', async () => {
    const { service } = setup({ occupied: ['location_B1'] });

    expect(await service.planFor('location_A3', ZONE)).toEqual({
      cells: ['A2', 'A1', 'corr'],
      egress: 'corrC',
    });
  });

  it('still turns off the lane when the retreat ends on its approach corridor', async () => {
    const { service } = setup({
      kernelApi: { findPointForLocation: jest.fn().mockResolvedValue('A2') },
    });

    expect(await service.planFor('location_A2', ZONE)).toEqual({
      cells: ['A1', 'corr'],
      egress: 'corrC',
    });
  });

  it('reads the topology from the live kernel, never from a file', async () => {
    const { service, kernelApi } = setup();

    await service.planFor('location_A3', ZONE);

    expect(kernelApi.getPlantModelView).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit cell count', async () => {
    const { service } = setup();

    expect(await service.planFor('location_A3', ZONE, 1)).toEqual({
      cells: ['A2', 'A1'],
      egress: 'C1',
    });
  });

  it('returns null when the location has no linked point', async () => {
    const { service, kernelApi } = setup({
      kernelApi: { findPointForLocation: jest.fn().mockResolvedValue(null) },
    });

    expect(await service.planFor('location_unknown', ZONE)).toBeNull();
    expect(kernelApi.getPlantModelView).not.toHaveBeenCalled();
  });

  it('returns null when the plant model is unavailable', async () => {
    const { service } = setup({
      kernelApi: { getPlantModelView: jest.fn().mockResolvedValue(null) },
    });

    expect(await service.planFor('location_A3', ZONE)).toBeNull();
  });

  it('returns null when the zone has no layout', async () => {
    const { service } = setup({ layout: null });

    expect(await service.planFor('location_A3', ZONE)).toBeNull();
  });

  it('returns null when the topology has no full retreat behind the slot', async () => {
    const { service } = setup({
      kernelApi: { findPointForLocation: jest.fn().mockResolvedValue('A1') },
    });

    expect(await service.planFor('location_A1', ZONE)).toBeNull();
  });
});
