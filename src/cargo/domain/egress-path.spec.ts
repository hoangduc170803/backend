import {
  describeEgressCell,
  egressCellHeldBy,
  egressCellsOf,
  laneExitCellsOf,
} from './egress-path';
import type { ZoneLane, ZoneSlotLayout } from './zone-slot-layout';

function slot(name: string) {
  return { locationName: `location_${name}`, pointName: name };
}

function lane(
  axis: number,
  slotNames: string[],
  exitNames: string[],
): ZoneLane {
  return {
    axis,
    slots: slotNames.map(slot),
    axisPoints: [...slotNames, ...exitNames],
    axisAlong: [...slotNames, ...exitNames].map((_, index) => index * 1000),
  };
}

const LANE_A = lane(40000, ['3067', '3068'], ['3066', '3065']);
const LANE_B = lane(41000, ['3075', '3076'], ['3074', '3065']);

function layoutOf(lanes: ZoneLane[]): ZoneSlotLayout {
  return {
    mainlinePoints: new Set<string>(),
    columns: lanes.map((each) => each.slots),
    lanes,
    entryPoints: [],
    memberPointNames: new Set(
      lanes.flatMap((each) => each.slots.map((one) => one.pointName)),
    ),
    strandedLocationNames: [],
  };
}

function bidirectional(from: string, to: string) {
  return {
    srcPointName: from,
    destPointName: to,
    maxVelocity: 1000,
    maxReverseVelocity: 1000,
  };
}

describe('laneExitCellsOf', () => {
  it('keeps the axis points that are not drop slots', () => {
    expect(laneExitCellsOf(LANE_A)).toEqual(['3066', '3065']);
  });

  it('is empty for a lane whose axis stops at its slots', () => {
    expect(laneExitCellsOf(lane(1000, ['S1', 'S2'], []))).toEqual([]);
  });
});

describe('egressCellsOf', () => {
  const layout = layoutOf([LANE_A, LANE_B]);

  it('measures how far out of the lane each exit cell sits', () => {
    const cells = egressCellsOf(layout, []);
    expect(cells.get('3066')).toEqual({
      pointName: '3066',
      kind: 'lane exit',
      laneIndexes: [0],
      cellsOutOfLane: 1,
    });
  });

  it('records every lane a shared fork cell belongs to, at its shallowest depth', () => {
    const cells = egressCellsOf(layout, []);
    expect(cells.get('3065')).toEqual({
      pointName: '3065',
      kind: 'lane exit',
      laneIndexes: [0, 1],
      cellsOutOfLane: 2,
    });
  });

  it('never reports a drop slot as an egress cell', () => {
    const cells = egressCellsOf(layout, []);
    expect(cells.has('3067')).toBe(false);
    expect(cells.has('3075')).toBe(false);
  });

  it('adds the cells traffic leaves the zone through', () => {
    const cells = egressCellsOf(layout, [bidirectional('3067', '0011')]);
    expect(cells.get('0011')?.kind).toBe('zone exit');
  });

  it('prefers the lane it belongs to when a cell is both', () => {
    const cells = egressCellsOf(layout, [bidirectional('3067', '3066')]);
    expect(cells.get('3066')?.kind).toBe('lane exit');
  });
});

describe('egressCellHeldBy', () => {
  const cells = egressCellsOf(layoutOf([LANE_A]), []);

  it('answers with the first held point that is an egress cell', () => {
    expect(egressCellHeldBy(cells, ['3067', '3066'])?.pointName).toBe('3066');
  });

  it('answers null when the vehicle holds nothing on the way out', () => {
    expect(egressCellHeldBy(cells, ['3067', '3068'])).toBeNull();
  });
});

describe('describeEgressCell', () => {
  it('names the lanes a shared cell blocks', () => {
    const cells = egressCellsOf(layoutOf([LANE_A, LANE_B]), []);
    expect(describeEgressCell(cells.get('3065') as never)).toBe(
      '3065 (2 cell(s) out of lane 0 and 1, a cell those lanes share)',
    );
  });

  it('says a zone exit cell is a way out of the zone', () => {
    const cells = egressCellsOf(layoutOf([LANE_A]), [
      bidirectional('3067', '0011'),
    ]);
    expect(describeEgressCell(cells.get('0011') as never)).toBe(
      '0011 (a cell traffic leaves the zone through)',
    );
  });
});
