import {
  allocatedPointNames,
  allocationReachesPoints,
  isDeeperInSameLane,
  isPathResource,
} from './lane-safety.policy';

describe('isPathResource', () => {
  it('recognises a path by its " --- " separator', () => {
    expect(isPathResource('1005 --- 0076')).toBe(true);
  });

  it('treats a plain point name as a point', () => {
    expect(isPathResource('0076')).toBe(false);
  });

  it('does not mistake a hyphenated point name for a path', () => {
    expect(isPathResource('PARK-1')).toBe(false);
  });
});

describe('allocatedPointNames', () => {
  it('flattens the resource sets and keeps only points', () => {
    expect(
      allocatedPointNames([
        ['0076', '1005 --- 0076'],
        ['1005', '0021 --- 1005'],
      ]),
    ).toEqual(['0076', '1005']);
  });

  it('returns nothing for a resource set holding only a trailing path', () => {
    expect(allocatedPointNames([['1005 --- 0076']])).toEqual([]);
  });

  it('returns nothing when the vehicle holds no resources', () => {
    expect(allocatedPointNames([])).toEqual([]);
  });
});

describe('allocationReachesPoints', () => {
  const lane = new Set(['0076', '0077']);

  it('is true when an allocated point belongs to the lane', () => {
    expect(allocationReachesPoints([['0076', '1005 --- 0076']], lane)).toBe(
      true,
    );
  });

  it('is false when allocated points are all outside the lane', () => {
    expect(allocationReachesPoints([['1005', '0021 --- 1005']], lane)).toBe(
      false,
    );
  });

  it('ignores a path even when its name embeds a lane point', () => {
    expect(allocationReachesPoints([['1005 --- 0076']], lane)).toBe(false);
  });

  it('is false against an empty lane', () => {
    expect(allocationReachesPoints([['0076']], new Set())).toBe(false);
  });
});

describe('isDeeperInSameLane', () => {
  const reference = { laneKey: 0, depthKey: 1000 };

  it('is true for a deeper slot of the same lane', () => {
    expect(isDeeperInSameLane({ laneKey: 0, depthKey: 2000 }, reference)).toBe(
      true,
    );
  });

  it('is false for a shallower slot of the same lane', () => {
    expect(isDeeperInSameLane({ laneKey: 0, depthKey: 0 }, reference)).toBe(
      false,
    );
  });

  it('is false for the same depth (the slot itself)', () => {
    expect(isDeeperInSameLane({ laneKey: 0, depthKey: 1000 }, reference)).toBe(
      false,
    );
  });

  it('is false for a deeper slot in another lane', () => {
    expect(
      isDeeperInSameLane({ laneKey: 1000, depthKey: 3000 }, reference),
    ).toBe(false);
  });
});
