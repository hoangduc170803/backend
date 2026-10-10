import { readFileSync } from 'fs';
import { join } from 'path';
import { parseOpenTcsXml } from '../../opentcs/map-loader/opentcs-xml.parser';
import { laneAxisOf } from '../../zones/domain/mainline';
import { buildZoneSlotLayout, type ZoneLane } from './zone-slot-layout';
import { queueOfLane, whereToQueue } from './dropoff-lane';
import { targetOf } from './column-queue';

const DROPOFF_ZONE_4 = [
  'location_0157',
  'location_0158',
  'location_0167',
  'location_0168',
  'location_0177',
  'location_0178',
];

function layoutOfXuonghientai(members: string[] = DROPOFF_ZONE_4) {
  const xml = readFileSync(
    join(__dirname, '..', '..', '..', 'maps', 'v7-Xuonghientai.xml'),
    'utf-8',
  );
  const model = parseOpenTcsXml(xml);
  const laneAxis = laneAxisOf(
    model.points,
    model.paths,
    model.visualLayout.properties,
  ).axis;
  return buildZoneSlotLayout(
    model.points,
    model.paths,
    model.locations,
    members,
    laneAxis,
  );
}

function laneAt(lanes: readonly ZoneLane[], axis: number): ZoneLane {
  const lane = lanes.find((candidate) => candidate.axis === axis);
  if (!lane) throw new Error(`no lane at ${axis}`);
  return lane;
}

describe('v7-Xuonghientai drop-off zone 4', () => {
  it('runs its lanes along y and finds two of them', () => {
    const layout = layoutOfXuonghientai();

    expect(layout.lanes.map((lane) => lane.axis).sort()).toEqual([4500, 5450]);
  });

  it('walks the lane tail out to the last cell the column actually reaches', () => {
    const layout = layoutOfXuonghientai();

    expect(laneAt(layout.lanes, 4500).axisPoints).toEqual([
      '0178',
      '0168',
      '0158',
      '0148',
      '0138',
      '0128',
    ]);
  });

  it('still offers a waiting cell once a pallet is down and the next slot is committed', () => {
    const layout = layoutOfXuonghientai();
    const laneIndex = layout.lanes.indexOf(laneAt(layout.lanes, 4500));

    const queue = queueOfLane(layout, laneIndex, {
      finished: new Set(['location_0178']),
      committed: new Set(['location_0168']),
      reserved: new Set<string>(),
    });

    expect(queue.standing().map(targetOf)).toEqual(['location_0168', '0128']);
    expect(queue.standing().slice(1).map(targetOf)).toEqual(['0128']);
  });
});

describe('v7-Xuonghientai lane admission over time', () => {
  const occupancyOf = (
    reserved: string[],
    committed: string[],
    finished: string[],
  ) => ({
    columnClaims: () => ({
      reserved: new Set(reserved),
      committed: new Set(committed),
      finished: new Set(finished),
    }),
    activeCountByLane: () => [reserved.length + committed.length],
  });

  it('seats each newcomer behind whoever already holds a cell in the lane', () => {
    const layout = layoutOfXuonghientai([
      'location_0158',
      'location_0168',
      'location_0178',
    ]);
    const ask = (r: string[], c: string[], f: string[]) =>
      whereToQueue(layout, occupancyOf(r, c, f) as never);

    expect(ask([], [], [])).toBe('location_0178');
    expect(ask(['location_0178'], [], [])).toBe('0138');
    expect(ask(['location_0178', '0138'], [], [])).toBeNull();
    expect(ask(['0138'], ['location_0178'], [])).toBeNull();
    expect(ask(['0138'], [], ['location_0178'])).toBe('0128');
  });
});
