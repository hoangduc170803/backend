import {
  checkZoneReachability,
  computeEgressPoints,
  computeFeederPoints,
  hopsToExit,
  type PlantPath,
  checkLaneInvariants,
} from './zone-topology';

const oneWay = (srcPointName: string, destPointName: string): PlantPath => ({
  srcPointName,
  destPointName,
  maxVelocity: 1,
  maxReverseVelocity: 0,
});

const twoWay = (srcPointName: string, destPointName: string): PlantPath => ({
  srcPointName,
  destPointName,
  maxVelocity: 1,
  maxReverseVelocity: 1,
});

describe('computeFeederPoints', () => {
  const v7Slice: PlantPath[] = [
    oneWay('0011', '0012'),
    oneWay('0012', '0013'),
    oneWay('0013', '3041'),
    oneWay('0012', '3049'),
    oneWay('3041', '3042'),
    oneWay('3041', '3049'),
    oneWay('3049', '3050'),
    oneWay('3049', '3057'),
    oneWay('3057', '0011'),
  ];
  const members = new Set(['3041', '3042', '3049', '3050']);

  it('returns the entry-most member points (aisle heads), not the external points', () => {
    expect(computeFeederPoints(v7Slice, members).sort()).toEqual([
      '3041',
      '3049',
    ]);
  });

  it('excludes members reachable only from inside the zone (no external inbound)', () => {
    const feeders = computeFeederPoints(v7Slice, members);
    expect(feeders).not.toContain('3042');
    expect(feeders).not.toContain('3050');
  });

  it('dedups when one member head has several external feeders', () => {
    const paths: PlantPath[] = [oneWay('0011', '3049'), oneWay('0012', '3049')];
    expect(computeFeederPoints(paths, new Set(['3049']))).toEqual(['3049']);
  });

  it('returns [] when no external inbound path exists (fallback case)', () => {
    const paths: PlantPath[] = [oneWay('3041', '3042'), oneWay('3042', '3043')];
    expect(
      computeFeederPoints(paths, new Set(['3041', '3042', '3043'])),
    ).toEqual([]);
  });

  it('treats a two-way member→external path as an inbound feeder', () => {
    const paths: PlantPath[] = [twoWay('3049', '0012')];
    expect(computeFeederPoints(paths, new Set(['3049']))).toEqual(['3049']);
  });

  it('ignores a one-way member→external path as a feeder', () => {
    const paths: PlantPath[] = [oneWay('3049', '0012')];
    expect(computeFeederPoints(paths, new Set(['3049']))).toEqual([]);
  });

  it('ignores paths with missing endpoints', () => {
    const paths: PlantPath[] = [
      { srcPointName: '0012', maxVelocity: 1, maxReverseVelocity: 0 },
      { destPointName: '3049', maxVelocity: 1, maxReverseVelocity: 0 },
      oneWay('0012', '3049'),
    ];
    expect(computeFeederPoints(paths, new Set(['3049']))).toEqual(['3049']);
  });
});

describe('checkZoneReachability', () => {
  const v7Slice: PlantPath[] = [
    oneWay('0011', '0012'),
    oneWay('0012', '0013'),
    oneWay('0013', '3041'),
    oneWay('0012', '3049'),
    oneWay('3041', '3042'),
    oneWay('3041', '3049'),
    oneWay('3049', '3050'),
    oneWay('3049', '3057'),
    oneWay('3057', '0011'),
  ];
  const members = new Set(['3041', '3042', '3049', '3050']);

  it('reports every member reachable from every head on a well-formed zone', () => {
    const r = checkZoneReachability(v7Slice, members);
    expect(r.feeders.sort()).toEqual(['3041', '3049']);
    expect(r.unreachable).toEqual([]);
    expect(r.maxHops).toBeGreaterThan(0);
  });

  it('flags a member unreachable from a feeder as unreachable (block case)', () => {
    const paths: PlantPath[] = [...v7Slice, oneWay('9999', '3041')];
    const withIsolated = new Set([...members, '9999']);
    const r = checkZoneReachability(paths, withIsolated);
    expect(r.unreachable).toContain('9999');
  });

  it('flags members not reachable from EVERY head (strict) → block', () => {
    const paths: PlantPath[] = [
      oneWay('0013', '3041'),
      oneWay('3041', '3042'),
      oneWay('0012', '3049'),
    ];
    const m = new Set(['3041', '3042', '3049']);
    const r = checkZoneReachability(paths, m);
    expect(r.feeders.sort()).toEqual(['3041', '3049']);
    expect(r.unreachable.sort()).toEqual(['3041', '3042', '3049']);
  });

  it('clears the strict block when the heads cross-connect two-way', () => {
    const paths: PlantPath[] = [
      oneWay('0013', '3041'),
      oneWay('3041', '3042'),
      oneWay('0012', '3049'),
      twoWay('3041', '3049'),
    ];
    const m = new Set(['3041', '3042', '3049']);
    const r = checkZoneReachability(paths, m);
    expect(r.feeders.sort()).toEqual(['3041', '3049']);
    expect(r.unreachable).toEqual([]);
  });

  it('keeps the strict block when the heads cross-connect one way only', () => {
    const paths: PlantPath[] = [
      oneWay('0013', '3041'),
      oneWay('3041', '3042'),
      oneWay('0012', '3049'),
      oneWay('3041', '3049'),
    ];
    const m = new Set(['3041', '3042', '3049']);
    const r = checkZoneReachability(paths, m);
    expect(r.unreachable.sort()).toEqual(['3041', '3042']);
  });

  it('returns empty when there are no feeders (cannot verify)', () => {
    const paths: PlantPath[] = [oneWay('3041', '3042')];
    const r = checkZoneReachability(paths, new Set(['3041', '3042']));
    expect(r.feeders).toEqual([]);
    expect(r.unreachable).toEqual([]);
  });
});

describe('computeEgressPoints / hopsToExit', () => {
  const members = new Set(['A', 'B', 'C']);
  const lane: PlantPath[] = [
    oneWay('entry', 'A'),
    oneWay('A', 'B'),
    oneWay('B', 'C'),
    oneWay('C', 'EXIT'),
  ];

  it('detects egress = external points a member flows into', () => {
    expect(computeEgressPoints(lane, members)).toEqual(['EXIT']);
    expect(computeEgressPoints(lane, members)).not.toContain('entry');
  });

  it('ranks members by forward hops to the exit (farther = larger)', () => {
    const hops = hopsToExit(lane, members, ['EXIT']);
    expect(hops.get('C')).toBe(1);
    expect(hops.get('B')).toBe(2);
    expect(hops.get('A')).toBe(3);
  });

  it('omits members with no path to the exit', () => {
    const paths: PlantPath[] = [oneWay('A', 'B'), oneWay('B', 'EXIT')];
    const hops = hopsToExit(paths, new Set(['A', 'B', 'C']), ['EXIT']);
    expect(hops.get('A')).toBe(2);
    expect(hops.get('B')).toBe(1);
    expect(hops.has('C')).toBe(false);
  });

  it('reaches the exit by reversing along a two-way path', () => {
    const paths: PlantPath[] = [oneWay('A', 'B'), twoWay('EXIT', 'B')];
    const hops = hopsToExit(paths, new Set(['A', 'B']), ['EXIT']);
    expect(computeEgressPoints(paths, new Set(['A', 'B']))).toEqual(['EXIT']);
    expect(hops.get('B')).toBe(1);
    expect(hops.get('A')).toBe(2);
  });

  it('does not reach the exit backwards along a one-way path', () => {
    const paths: PlantPath[] = [oneWay('A', 'B'), oneWay('EXIT', 'B')];
    const hops = hopsToExit(paths, new Set(['A', 'B']), ['EXIT']);
    expect(hops.has('B')).toBe(false);
    expect(hops.has('A')).toBe(false);
  });
});

describe('checkLaneInvariants', () => {
  const at = (name: string, x: number, y: number) => ({
    name,
    position: { x, y },
  });
  const lane = [
    at('corr2', 1000, 0),
    at('corr1', 1000, -1000),
    at('A1', 1000, -2000),
    at('A2', 1000, -3000),
  ];
  const members = new Set(['A1', 'A2']);
  const spine: PlantPath[] = [
    twoWay('corr2', 'corr1'),
    twoWay('corr1', 'A1'),
    twoWay('A1', 'A2'),
  ];

  it('accepts a lane with two corridor points straight above it', () => {
    expect(checkLaneInvariants(lane, spine, members)).toEqual([]);
  });

  it('reports V1 when the lane has only one corridor point above it', () => {
    const short = lane.slice(1);
    const paths = spine.slice(1);
    const violations = checkLaneInvariants(short, paths, members);

    expect(violations.map((v) => v.code)).toEqual(['V1']);
    expect(violations[0].detail).toContain('A1');
  });

  it('reports V1 when the way up out of the lane is one-way inwards', () => {
    const paths: PlantPath[] = [
      twoWay('corr2', 'corr1'),
      oneWay('corr1', 'A1'),
      twoWay('A1', 'A2'),
    ];

    expect(
      checkLaneInvariants(lane, paths, members).map((v) => v.code),
    ).toEqual(['V1']);
  });

  it('reports V3 when two lanes are joined in both directions', () => {
    const points = [
      ...lane,
      at('cB2', 2000, 0),
      at('cB1', 2000, -1000),
      at('B1', 2000, -2000),
      at('B2', 2000, -3000),
    ];
    const twoLaneMembers = new Set(['A1', 'A2', 'B1', 'B2']);
    const paths: PlantPath[] = [
      ...spine,
      twoWay('cB2', 'cB1'),
      twoWay('cB1', 'B1'),
      twoWay('B1', 'B2'),
      twoWay('A2', 'B2'),
    ];

    const violations = checkLaneInvariants(points, paths, twoLaneMembers);

    expect(violations.map((v) => v.code)).toContain('V3');
  });

  it('reports V3 when cross-lane paths disagree on direction', () => {
    const points = [
      ...lane,
      at('cB2', 2000, 0),
      at('cB1', 2000, -1000),
      at('B1', 2000, -2000),
      at('B2', 2000, -3000),
    ];
    const twoLaneMembers = new Set(['A1', 'A2', 'B1', 'B2']);
    const paths: PlantPath[] = [
      ...spine,
      twoWay('cB2', 'cB1'),
      twoWay('cB1', 'B1'),
      twoWay('B1', 'B2'),
      oneWay('A1', 'B1'),
      oneWay('B2', 'A2'),
    ];

    const violations = checkLaneInvariants(points, paths, twoLaneMembers);

    expect(violations.map((v) => v.code)).toContain('V3');
  });

  it('accepts cross-lane paths that all run one way in the same direction', () => {
    const points = [
      ...lane,
      at('cB2', 2000, 0),
      at('cB1', 2000, -1000),
      at('B1', 2000, -2000),
      at('B2', 2000, -3000),
    ];
    const twoLaneMembers = new Set(['A1', 'A2', 'B1', 'B2']);
    const paths: PlantPath[] = [
      ...spine,
      twoWay('cB2', 'cB1'),
      twoWay('cB1', 'B1'),
      twoWay('B1', 'B2'),
      oneWay('A1', 'B1'),
      oneWay('A2', 'B2'),
    ];

    expect(checkLaneInvariants(points, paths, twoLaneMembers)).toEqual([]);
  });
});
