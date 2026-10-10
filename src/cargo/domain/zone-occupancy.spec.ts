import { ZoneOccupancy, type ZoneClaim } from './zone-occupancy';
import { CargoStatus } from '../entities/cargo.entity';
import type { ZoneLane, ZoneSlotLayout } from './zone-slot-layout';

const slot = (pointName: string) => ({
  locationName: `location_${pointName}`,
  pointName,
});

const laneA: ZoneLane = {
  axis: 0,
  slots: [slot('A3'), slot('A2'), slot('A1')],
  axisPoints: ['A3', 'A2', 'A1', 'corrA'],
  axisAlong: [0, 1000, 2000, 3000],
};

const laneB: ZoneLane = {
  axis: 1000,
  slots: [slot('B2'), slot('B1')],
  axisPoints: ['B2', 'B1', 'corrB'],
  axisAlong: [0, 1000, 2000],
};

const layout: ZoneSlotLayout = {
  mainlinePoints: new Set<string>(),
  columns: [laneA.slots, laneB.slots],
  lanes: [laneA, laneB],
  entryPoints: ['A1', 'B1'],
  memberPointNames: new Set(['A3', 'A2', 'A1', 'B2', 'B1']),
  strandedLocationNames: [],
};

function claim(id: string, fields: Partial<ZoneClaim> = {}): ZoneClaim {
  return {
    id,
    status: CargoStatus.ACTIVE,
    destinationLocationName: null,
    reservedLocationName: null,
    ...fields,
  };
}

function occupancyOf(...claims: ZoneClaim[]): ZoneOccupancy {
  return ZoneOccupancy.of(claims, layout);
}

describe('committedSlots', () => {
  it('counts a delivered cargo too, because its pallet still sits there', () => {
    const occupancy = occupancyOf(
      claim('c1', { destinationLocationName: 'location_A3' }),
      claim('c2', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_A2',
      }),
      claim('c3', { reservedLocationName: 'location_A1' }),
    );

    expect([...occupancy.committedSlots()].sort()).toEqual([
      'location_A2',
      'location_A3',
    ]);
  });
});

describe('claimedTargets', () => {
  it('holds corridor points as well as slots, because a queue waits on points', () => {
    const occupancy = occupancyOf(
      claim('c1', { destinationLocationName: 'location_A3' }),
      claim('c2', { reservedLocationName: 'corrA' }),
    );

    expect([...occupancy.claimedTargets()].sort()).toEqual([
      'corrA',
      'location_A3',
    ]);
  });
});

describe('activeCountByLane', () => {
  it('counts commits and reservations against the lane they aim at', () => {
    const occupancy = occupancyOf(
      claim('c1', { destinationLocationName: 'location_A3' }),
      claim('c2', { reservedLocationName: 'corrA' }),
      claim('c3', { reservedLocationName: 'location_B2' }),
    );

    expect(occupancy.activeCountByLane()).toEqual([2, 1]);
  });

  it('counts a cell once, however many cargos were delivered onto it', () => {
    const occupancy = occupancyOf(
      claim('c1', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_A3',
      }),
      claim('c2', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_A3',
      }),
      claim('c3', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_A3',
      }),
    );

    expect(occupancy.activeCountByLane()).toEqual([1, 0]);
  });

  it('keeps the lane balance honest when old drop-offs pile up', () => {
    const stacked = ['location_A3', 'location_A3', 'location_A2'].map(
      (cell, index) =>
        claim(`old-${index}`, {
          status: CargoStatus.DELIVERED,
          destinationLocationName: cell,
        }),
    );
    const occupancy = occupancyOf(
      ...stacked,
      claim('b1', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_B2',
      }),
    );

    expect(occupancy.activeCountByLane()).toEqual([2, 1]);
  });

  it('counts a committed cargo once, not again for its stale reservation', () => {
    const occupancy = occupancyOf(
      claim('c1', {
        destinationLocationName: 'location_A3',
        reservedLocationName: 'location_A2',
      }),
    );

    expect(occupancy.activeCountByLane()).toEqual([1, 0]);
  });
});

describe('committedInLane', () => {
  it('names the one vehicle that owns the lane right now', () => {
    const occupancy = occupancyOf(
      claim('c1', { destinationLocationName: 'location_A3' }),
      claim('c2', { destinationLocationName: 'location_B2' }),
    );

    expect(occupancy.committedInLane(0)).toBe('location_A3');
    expect(occupancy.committedInLane(1)).toBe('location_B2');
  });

  it('reports the lane as free once the drop is done', () => {
    const occupancy = occupancyOf(
      claim('c1', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_A3',
      }),
    );

    expect(occupancy.committedInLane(0)).toBeNull();
  });
});

describe('holderOf', () => {
  it('finds who is queued on a target so it can be sent elsewhere', () => {
    const committer = claim('c1');
    const occupancy = occupancyOf(
      committer,
      claim('c2', { reservedLocationName: 'location_A2' }),
    );

    expect(occupancy.holderOf('location_A2', committer)?.id).toBe('c2');
  });

  it('ignores the asker, so a cargo never displaces itself', () => {
    const committer = claim('c1', { reservedLocationName: 'location_A2' });

    expect(
      occupancyOf(committer).holderOf('location_A2', committer),
    ).toBeNull();
  });

  it('ignores a cargo that has already committed elsewhere', () => {
    const committer = claim('c1');
    const occupancy = occupancyOf(
      committer,
      claim('c2', {
        reservedLocationName: 'location_A2',
        destinationLocationName: 'location_A3',
      }),
    );

    expect(occupancy.holderOf('location_A2', committer)).toBeNull();
  });
});
