import {
  MAX_COLUMN_LEAD,
  buildZoneSlotLayout,
  columnIndexOfPoint,
  columnLocationNames,
  laneOfPoint,
  rankSlots,
  usableSlotCount,
  type PlantPoint,
  type ZoneSlotLayout,
} from './zone-slot-layout';
import type { PlantPath } from '../../zones/domain/zone-topology';
import type { PlantLocation } from '../../zones/domain/member-points';

const SHALLOW_X = 1000;
const DEEP_X = 2000;
const AISLE_X = 0;
const ROW_PITCH = -1000;

interface Rack {
  points: PlantPoint[];
  paths: PlantPath[];
  locations: PlantLocation[];
  memberLocationNames: string[];
  shallow: string[];
  deep: string[];
}

function twoWay(src: string, dest: string): PlantPath {
  return {
    srcPointName: src,
    destPointName: dest,
    maxVelocity: 1,
    maxReverseVelocity: 1,
  };
}

function oneWay(src: string, dest: string): PlantPath {
  return {
    srcPointName: src,
    destPointName: dest,
    maxVelocity: 1,
    maxReverseVelocity: 0,
  };
}

function rack(rows: number, rowPitch: number = ROW_PITCH): Rack {
  const points: PlantPoint[] = [
    { name: 'entry-shallow', position: { x: SHALLOW_X, y: 0 } },
    { name: 'entry-deep', position: { x: DEEP_X, y: 0 } },
  ];
  const paths: PlantPath[] = [];
  const shallow: string[] = [];
  const deep: string[] = [];

  for (let row = 1; row <= rows; row++) {
    const y = row * rowPitch;
    const shallowPoint = `S${row}`;
    const deepPoint = `D${row}`;
    const aislePoint = `A${row}`;
    shallow.push(shallowPoint);
    deep.push(deepPoint);
    points.push(
      { name: shallowPoint, position: { x: SHALLOW_X, y } },
      { name: deepPoint, position: { x: DEEP_X, y } },
      { name: aislePoint, position: { x: AISLE_X, y } },
    );
    paths.push(
      oneWay(shallowPoint, aislePoint),
      twoWay(deepPoint, shallowPoint),
    );
    if (row === 1) {
      paths.push(
        twoWay('entry-shallow', shallowPoint),
        twoWay('entry-deep', deepPoint),
      );
    } else {
      paths.push(
        twoWay(shallow[row - 2], shallowPoint),
        twoWay(deep[row - 2], deepPoint),
      );
    }
  }

  const memberPoints = [...shallow, ...deep];
  return {
    points,
    paths,
    locations: memberPoints.map((point) => ({
      name: `location_${point}`,
      links: [{ pointName: point }],
    })),
    memberLocationNames: memberPoints.map((point) => `location_${point}`),
    shallow,
    deep,
  };
}

function layoutOf(built: Rack): ZoneSlotLayout {
  return buildZoneSlotLayout(
    built.points,
    built.paths,
    built.locations,
    built.memberLocationNames,
  );
}

function fillOrder(layout: ZoneSlotLayout): string[] {
  return rankSlots(layout, new Set()).map((slot) => slot.pointName);
}

describe('buildZoneSlotLayout', () => {
  it('splits the rack into lanes, each ordered from its far end towards the entrance', () => {
    const layout = layoutOf(rack(4));

    expect(layout.lanes.map((lane) => lane.axis)).toEqual([DEEP_X, SHALLOW_X]);
    expect(layout.lanes[0].slots.map((s) => s.pointName)).toEqual([
      'D4',
      'D3',
      'D2',
      'D1',
    ]);
    expect(layout.lanes[1].slots.map((s) => s.pointName)).toEqual([
      'S4',
      'S3',
      'S2',
      'S1',
    ]);
  });

  it('makes each lane one column, the one farthest from the exit first', () => {
    const layout = layoutOf(rack(4));

    expect(layout.columns.map((c) => c.map((s) => s.pointName))).toEqual([
      ['D4', 'D3', 'D2', 'D1'],
      ['S4', 'S3', 'S2', 'S1'],
    ]);
  });

  it('keeps slots of different lanes in different columns', () => {
    const layout = layoutOf(rack(4));

    expect(columnIndexOfPoint(layout, 'S3')).not.toBe(
      columnIndexOfPoint(layout, 'D3'),
    );
  });

  it('reports the entrances of the rack as its commit gates', () => {
    const layout = layoutOf(rack(4));

    expect([...layout.entryPoints].sort()).toEqual(['D1', 'S1']);
  });

  it('drops a slot that cannot reach the exit instead of offering it', () => {
    const built = rack(3);
    built.points.push({ name: 'orphan', position: { x: 9000, y: 9000 } });
    built.locations.push({
      name: 'location_orphan',
      links: [{ pointName: 'orphan' }],
    });
    built.memberLocationNames.push('location_orphan');

    const layout = layoutOf(built);

    expect(layout.strandedLocationNames).toEqual(['location_orphan']);
    expect(usableSlotCount(layout)).toBe(6);
    expect(layout.lanes.map((lane) => lane.axis)).toEqual([DEEP_X, SHALLOW_X]);
  });
});

describe('usableSlotCount', () => {
  it('counts every slot, because a dropped pallet keeps its cell whatever the pitch', () => {
    expect(usableSlotCount(layoutOf(rack(4, -750)))).toBe(8);
  });
});

describe('laneOfPoint', () => {
  it('tells which lane a vehicle standing on a slot is in', () => {
    const layout = layoutOf(rack(4));

    expect(laneOfPoint(layout, 'D3')?.axis).toBe(DEEP_X);
    expect(laneOfPoint(layout, 'S3')?.axis).toBe(SHALLOW_X);
  });

  it('reports no lane for a point outside the rack', () => {
    const layout = layoutOf(rack(4));

    expect(laneOfPoint(layout, 'A2')).toBeNull();
  });
});

describe('columnIndexOfPoint', () => {
  it('reports the lane a slot belongs to, whatever its depth', () => {
    const layout = layoutOf(rack(4));

    expect(columnIndexOfPoint(layout, 'D4')).toBe(0);
    expect(columnIndexOfPoint(layout, 'D1')).toBe(0);
    expect(columnIndexOfPoint(layout, 'S1')).toBe(1);
  });

  it('reports no column for a point outside the rack', () => {
    const layout = layoutOf(rack(4));

    expect(columnIndexOfPoint(layout, 'A2')).toBeNull();
  });

  it('lists the slots a vehicle may still take without changing depth', () => {
    const layout = layoutOf(rack(4));

    expect([...columnLocationNames(layout, 0)].sort()).toEqual([
      'location_D1',
      'location_D2',
      'location_D3',
      'location_D4',
    ]);
    expect(columnLocationNames(layout, 9).size).toBe(0);
  });
});

describe('rankSlots', () => {
  it('offers every slot that is not occupied', () => {
    const layout = layoutOf(rack(4));

    expect(rankSlots(layout, new Set())).toHaveLength(8);
    expect(
      rankSlots(layout, new Set(['location_D4', 'location_S4'])),
    ).toHaveLength(6);
  });

  it('fills one lane deep-first and only switches once it leads by the buffer', () => {
    expect(fillOrder(layoutOf(rack(4)))).toEqual([
      'D4',
      'D3',
      'D2',
      'S4',
      'D1',
      'S3',
      'S2',
      'S1',
    ]);
  });

  it('takes the lead count from the caller, so a target off the slots still counts', () => {
    const layout = layoutOf(rack(4));

    expect(rankSlots(layout, new Set(), [3, 0])[0].pointName).toBe('S4');
    expect(rankSlots(layout, new Set())[0].pointName).toBe('D4');
  });

  it('never lets a lane run more than MAX_COLUMN_LEAD ahead of the next one', () => {
    const layout = layoutOf(rack(8));
    const laneOfPointName = new Map<string, number>();
    layout.columns.forEach((column, index) =>
      column.forEach((slot) => laneOfPointName.set(slot.pointName, index)),
    );

    const filled = new Array<number>(layout.columns.length).fill(0);
    let widestLead = 0;
    for (const point of fillOrder(layout)) {
      filled[laneOfPointName.get(point)!]++;
      for (let index = 0; index < filled.length - 1; index++) {
        widestLead = Math.max(widestLead, filled[index] - filled[index + 1]);
      }
    }

    expect(widestLead).toBeLessThanOrEqual(MAX_COLUMN_LEAD);
  });

  it('moves to the next lane once the first one is full', () => {
    const layout = layoutOf(rack(3));
    const firstLaneTaken = new Set(
      layout.columns[0].map((slot) => slot.locationName),
    );

    expect(rankSlots(layout, firstLaneTaken).map((s) => s.pointName)).toEqual([
      'S3',
      'S2',
      'S1',
    ]);
  });

  it('resumes the cascade from the slots that are already occupied', () => {
    const built = rack(8);
    const layout = layoutOf(built);
    const deepHeadStart = new Set(
      ['D8', 'D7', 'D6'].map((point) => `location_${point}`),
    );

    expect(rankSlots(layout, deepHeadStart)[0].pointName).toBe('S8');
  });
});
