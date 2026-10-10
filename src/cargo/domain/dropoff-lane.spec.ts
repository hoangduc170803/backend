import {
  spotInReservedLane,
  serveOrder,
  standsOnASlot,
  queueDiagnosis,
  whereToQueue,
} from './dropoff-lane';
import { ZoneOccupancy, type ZoneClaim } from './zone-occupancy';
import { CargoStatus } from '../entities/cargo.entity';
import type { ZoneLane, ZoneSlotLayout } from './zone-slot-layout';

const slot = (pointName: string) => ({
  locationName: `location_${pointName}`,
  pointName,
});

const DEEP_LANE: ZoneLane = {
  axis: 0,
  slots: ['P5', 'P4', 'P3', 'P2', 'P1'].map(slot),
  axisPoints: ['P5', 'P4', 'P3', 'P2', 'P1', 'corr', 'mainline'],
  axisAlong: [0, 1000, 2000, 3000, 4000, 5000, 6000],
};

const SIDE_LANE: ZoneLane = {
  axis: 1000,
  slots: ['Q2', 'Q1'].map(slot),
  axisPoints: ['Q2', 'Q1', 'corrQ'],
  axisAlong: [0, 1000, 2000],
};

const LAYOUT: ZoneSlotLayout = {
  mainlinePoints: new Set<string>(),
  columns: [DEEP_LANE.slots, SIDE_LANE.slots],
  lanes: [DEEP_LANE, SIDE_LANE],
  entryPoints: ['P1', 'Q1'],
  memberPointNames: new Set(['P1', 'P2', 'P3', 'P4', 'P5', 'Q1', 'Q2']),
  strandedLocationNames: [],
};

describe('spotInReservedLane', () => {
  it('places a vehicle standing on a cell of the lane it was sent to', () => {
    expect(spotInReservedLane(LAYOUT, 'location_P1', 'P3')).toEqual({
      lane: DEEP_LANE,
      depth: 2,
    });
  });

  it('places a vehicle queued on the corridor behind its own lane', () => {
    expect(spotInReservedLane(LAYOUT, 'location_P1', 'corr')?.depth).toBe(5);
  });

  it('counts depth from the far end, so deeper reads as smaller', () => {
    const deep = spotInReservedLane(LAYOUT, 'location_P1', 'P5')!;
    const shallow = spotInReservedLane(LAYOUT, 'location_P1', 'P1')!;

    expect(deep.depth).toBeLessThan(shallow.depth);
  });

  it('reads the lane off the reservation, not off the cell underneath', () => {
    expect(spotInReservedLane(LAYOUT, 'location_Q1', 'Q1')?.lane).toBe(
      SIDE_LANE,
    );
  });

  it('ignores a vehicle only crossing another lane on its way to its own', () => {
    expect(spotInReservedLane(LAYOUT, 'location_P3', 'corrQ')).toBeNull();
  });

  it('takes a waiting cell as the reservation too, not just a slot', () => {
    expect(spotInReservedLane(LAYOUT, 'corr', 'P2')?.lane).toBe(DEEP_LANE);
  });

  it('reports nothing for a vehicle that has not reached its lane yet', () => {
    expect(
      spotInReservedLane(LAYOUT, 'location_P1', 'somewhere-else'),
    ).toBeNull();
  });

  it('reports nothing when the reservation names no lane at all', () => {
    expect(spotInReservedLane(LAYOUT, 'somewhere-else', 'P3')).toBeNull();
  });
});

describe('standsOnASlot', () => {
  it('is true on a drop-off cell', () => {
    expect(standsOnASlot(DEEP_LANE, 'P2')).toBe(true);
  });

  it('is false on the corridor, which carries no cargo', () => {
    expect(standsOnASlot(DEEP_LANE, 'corr')).toBe(false);
  });
});

describe('serveOrder', () => {
  it('asks the vehicle deepest in the lane first', () => {
    const spots = [
      { depth: 5, id: 'shallow' },
      { depth: 1, id: 'deep' },
    ];

    expect(serveOrder(spots).map((s) => s.id)).toEqual(['deep', 'shallow']);
  });

  it('leaves the caller array untouched', () => {
    const spots = [{ depth: 5 }, { depth: 1 }];

    serveOrder(spots);

    expect(spots.map((s) => s.depth)).toEqual([5, 1]);
  });
});

describe('queueDiagnosis', () => {
  const claim = (id: string, fields: Partial<ZoneClaim> = {}): ZoneClaim => ({
    id,
    status: CargoStatus.ACTIVE,
    destinationLocationName: null,
    reservedLocationName: null,
    ...fields,
  });

  it('names the lane, what it holds and where its top sits', () => {
    const occupancy = ZoneOccupancy.of(
      [
        claim('c1', { destinationLocationName: 'location_P5' }),
        claim('c2', { reservedLocationName: 'location_P2' }),
        claim('c3', { reservedLocationName: 'location_P1' }),
        claim('c4', { reservedLocationName: 'corr' }),
        claim('c5', { reservedLocationName: 'mainline' }),
      ],
      LAYOUT,
    );

    const [deep] = queueDiagnosis(LAYOUT, occupancy);

    expect(deep).toContain('lane 0');
    expect(deep).toContain('top location_P5');
    expect(deep).toContain('holding location_P5');
  });

  it('shows a lane that is full rather than merely ineligible', () => {
    const occupancy = ZoneOccupancy.of(
      [claim('c1', { destinationLocationName: 'location_Q2' })],
      LAYOUT,
    );

    expect(queueDiagnosis(LAYOUT, occupancy)[1]).toContain(
      '0 reserved + 1 committed of 1',
    );
  });
});

describe('whereToQueue', () => {
  const claim = (id: string, fields: Partial<ZoneClaim> = {}): ZoneClaim => ({
    id,
    status: CargoStatus.ACTIVE,
    destinationLocationName: null,
    reservedLocationName: null,
    ...fields,
  });

  const occupancyOf = (...claims: ZoneClaim[]) =>
    ZoneOccupancy.of(claims, LAYOUT);

  it('sends the first arrival to the far end of the lane', () => {
    expect(whereToQueue(LAYOUT, occupancyOf())).toBe('location_P5');
  });

  it('holds the retreat cells back even before the deepest one commits', () => {
    const occupancy = occupancyOf(
      claim('c1', { reservedLocationName: 'location_P5' }),
    );

    expect(whereToQueue(LAYOUT, occupancy)).toBe('location_P2');
  });

  it('offers the cell behind a pallet whose vehicle has already left', () => {
    const occupancy = occupancyOf(
      claim('c1', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_P5',
      }),
      claim('c2', {
        status: CargoStatus.DELIVERED,
        destinationLocationName: 'location_P4',
      }),
    );

    expect(whereToQueue(LAYOUT, occupancy)).toBe('location_P3');
  });

  it('answers the same once that reservation turns into a commit', () => {
    const occupancy = occupancyOf(
      claim('c1', { destinationLocationName: 'location_P5' }),
    );

    expect(whereToQueue(LAYOUT, occupancy)).toBe('location_P2');
  });

  it('queues the one after that a further cell back', () => {
    const occupancy = occupancyOf(
      claim('c1', { destinationLocationName: 'location_P5' }),
      claim('c2', { reservedLocationName: 'location_P2' }),
    );

    expect(whereToQueue(LAYOUT, occupancy)).toBe('location_P1');
  });

  it('offers the corridor once the cells behind the retreat are taken', () => {
    const soloLayout: ZoneSlotLayout = {
      ...LAYOUT,
      columns: [DEEP_LANE.slots],
      lanes: [DEEP_LANE],
    };
    const occupancy = ZoneOccupancy.of(
      [
        claim('c1', { destinationLocationName: 'location_P5' }),
        claim('c2', { reservedLocationName: 'location_P2' }),
        claim('c3', { reservedLocationName: 'location_P1' }),
      ],
      soloLayout,
    );

    expect(whereToQueue(soloLayout, occupancy)).toBe('corr');
  });

  it('diverts to the next lane before offering the corridor of a full one', () => {
    const occupancy = occupancyOf(
      claim('c1', { destinationLocationName: 'location_P5' }),
      claim('c2', { reservedLocationName: 'location_P2' }),
      claim('c3', { reservedLocationName: 'location_P1' }),
    );

    expect(whereToQueue(LAYOUT, occupancy)).toBe('location_Q2');
  });

  it('moves to the next lane once this one leads by the buffer', () => {
    const occupancy = occupancyOf(
      claim('c1', { reservedLocationName: 'location_P5' }),
      claim('c2', { reservedLocationName: 'location_P4' }),
      claim('c3', { reservedLocationName: 'location_P3' }),
    );

    expect(whereToQueue(LAYOUT, occupancy)).toBe('location_Q2');
  });
});
