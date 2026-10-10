import {
  findBlocker,
  hasLeftColumn,
  isBlocked,
  PickupCandidate,
} from './pickup-dependency.policy';

const c = (
  taskId: string,
  laneKey: number,
  depthKey: number,
  extra: Partial<PickupCandidate> = {},
): PickupCandidate => ({
  taskId,
  laneKey,
  depthKey,
  locationName: taskId,
  atSource: true,
  vehicleName: null,
  vehicleLeftColumn: false,
  ...extra,
});

const LANE_POINTS = new Set(['P-A', 'P-B', 'P-C']);

describe('pickup-dependency.policy', () => {
  it('outermost cargo (smallest depth) is never blocked', () => {
    const outer = c('outer', 0, 1000);
    const inner = c('inner', 0, 2000);
    expect(isBlocked(outer, [outer, inner])).toBe(false);
  });

  it('inner cargo is blocked by an outer cargo in the same lane', () => {
    const outer = c('outer', 0, 1000);
    const inner = c('inner', 0, 2000);
    expect(isBlocked(inner, [outer, inner])).toBe(true);
    expect(findBlocker(inner, [outer, inner])?.taskId).toBe('outer');
  });

  it('cargos in different lanes never block each other', () => {
    const a = c('a', 0, 1000);
    const b = c('b', 1, 2000); // deeper but other lane
    expect(isBlocked(b, [a, b])).toBe(false);
  });

  it('same depth does not block (side by side, both reachable)', () => {
    const a = c('a', 0, 1000);
    const b = c('b', 0, 1000);
    expect(isBlocked(a, [a, b])).toBe(false);
  });

  it('reports the nearest-aisle blocker when several block', () => {
    const front = c('front', 0, 1000);
    const mid = c('mid', 0, 2000);
    const back = c('back', 0, 3000);
    expect(findBlocker(back, [front, mid, back])?.taskId).toBe('front');
  });

  it('a single cargo is never blocked by itself', () => {
    const only = c('only', 0, 5000);
    expect(isBlocked(only, [only])).toBe(false);
  });

  it('keeps blocking while the vehicle that took the cargo is still in the column', () => {
    const outer = c('outer', 0, 1000, {
      atSource: false,
      vehicleName: 'V1',
      vehicleLeftColumn: false,
    });
    const inner = c('inner', 0, 2000);
    expect(isBlocked(inner, [outer, inner])).toBe(true);
    expect(findBlocker(inner, [outer, inner])?.vehicleName).toBe('V1');
  });

  it('stops blocking once the cargo left the source and the vehicle left the column', () => {
    const outer = c('outer', 0, 1000, {
      atSource: false,
      vehicleName: 'V1',
      vehicleLeftColumn: true,
    });
    const inner = c('inner', 0, 2000);
    expect(isBlocked(inner, [outer, inner])).toBe(false);
  });

  it('keeps blocking a vehicle driving INTO the lane even though it holds a point outside', () => {
    const outer = c('outer', 0, 1000, {
      atSource: true,
      vehicleName: 'V1',
      vehicleLeftColumn: true,
    });
    const inner = c('inner', 0, 2000);
    expect(isBlocked(inner, [outer, inner])).toBe(true);
  });
});

describe('hasLeftColumn', () => {
  it('is false while every allocated point belongs to the lane', () => {
    expect(hasLeftColumn([['P-B', 'P-A']], LANE_POINTS)).toBe(false);
  });

  it('is true as soon as one allocated point sits outside the lane', () => {
    expect(hasLeftColumn([['P-A', 'P-AISLE']], LANE_POINTS)).toBe(true);
  });

  it('is false when nothing is allocated', () => {
    expect(hasLeftColumn([], LANE_POINTS)).toBe(false);
    expect(hasLeftColumn([[]], LANE_POINTS)).toBe(false);
  });

  it('does not read a path resource as a point outside the lane', () => {
    expect(hasLeftColumn([['P-A --- P-AISLE']], LANE_POINTS)).toBe(false);
  });
});
