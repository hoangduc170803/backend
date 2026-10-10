import {
  afterMoving,
  depthOfTarget,
  distanceToTarget,
  inversionIn,
  stuckForMs,
  type LaneStanding,
} from './lane-order';
import type { ZoneLane } from './zone-slot-layout';

const slot = (pointName: string) => ({
  locationName: `location_${pointName}`,
  pointName,
});

const LANE: ZoneLane = {
  axis: 40000,
  slots: ['3120', '3119', '3118', '3117', '3116', '3115', '3114'].map(slot),
  axisPoints: [
    '3120',
    '3119',
    '3118',
    '3117',
    '3116',
    '3115',
    '3114',
    '3066',
    '3065',
  ],
  axisAlong: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000],
};

const standing = (over: Partial<LaneStanding> = {}): LaneStanding => ({
  cargoId: 'cargo',
  posDepth: 0,
  targetDepth: 0,
  committed: false,
  unloaded: false,
  swapCount: 0,
  ...over,
});

describe('depthOfTarget', () => {
  it('reads the depth of a slot through its location name', () => {
    expect(depthOfTarget(LANE, 'location_3116')).toBe(4);
  });

  it('reads the depth of a bare waiting cell', () => {
    expect(depthOfTarget(LANE, '3066')).toBe(7);
  });

  it('reports -1 for a target that is not on this lane', () => {
    expect(depthOfTarget(LANE, 'location_3125')).toBe(-1);
  });
});

describe('distanceToTarget', () => {
  it('counts cells either way along the axis', () => {
    expect(distanceToTarget(standing({ posDepth: 2, targetDepth: 4 }))).toBe(2);
    expect(distanceToTarget(standing({ posDepth: 4, targetDepth: 2 }))).toBe(2);
  });
});

describe('inversionIn', () => {
  it('catches the vehicle that merged in front but holds the shallower slot', () => {
    const ahead = standing({
      cargoId: 'v7',
      posDepth: 2,
      targetDepth: 4,
    });
    const holder = standing({
      cargoId: 'v11',
      posDepth: 4,
      targetDepth: 1,
      committed: true,
    });

    expect(inversionIn([holder, ahead])).toEqual({ ahead, holder });
  });

  it('stays quiet when the deeper vehicle already holds the deeper slot', () => {
    const deep = standing({
      cargoId: 'v7',
      posDepth: 2,
      targetDepth: 0,
      committed: true,
    });
    const behind = standing({ cargoId: 'v11', posDepth: 4, targetDepth: 1 });

    expect(inversionIn([deep, behind])).toBeNull();
  });

  it('leaves a pallet that is already on the floor alone', () => {
    const ahead = standing({ cargoId: 'v7', posDepth: 2, targetDepth: 4 });
    const unloaded = standing({
      cargoId: 'v11',
      posDepth: 4,
      targetDepth: 1,
      committed: true,
      unloaded: true,
    });

    expect(inversionIn([unloaded, ahead])).toBeNull();
  });

  it('stays quiet when nobody in the lane holds a commit', () => {
    expect(
      inversionIn([
        standing({ cargoId: 'v7', posDepth: 2, targetDepth: 4 }),
        standing({ cargoId: 'v11', posDepth: 4, targetDepth: 1 }),
      ]),
    ).toBeNull();
  });

  it('picks the deepest vehicle still without a slot', () => {
    const deepest = standing({ cargoId: 'v7', posDepth: 1, targetDepth: 5 });
    const alsoWaiting = standing({
      cargoId: 'v6',
      posDepth: 3,
      targetDepth: 5,
    });
    const holder = standing({
      cargoId: 'v11',
      posDepth: 4,
      targetDepth: 0,
      committed: true,
    });

    expect(inversionIn([alsoWaiting, holder, deepest])?.ahead).toBe(deepest);
  });
});

describe('afterMoving', () => {
  it('starts the clock the first time it sees the lane', () => {
    const mark = afterMoving(undefined, [standing({ posDepth: 6 })], 1_000);

    expect(mark.lastProgressAt).toBe(1_000);
    expect(mark.bestDistanceByCargo.get('cargo')).toBe(6);
  });

  it('moves the clock on when a vehicle gets closer to its own slot', () => {
    const first = afterMoving(
      undefined,
      [standing({ posDepth: 6, targetDepth: 1 })],
      1_000,
    );
    const closer = afterMoving(
      first,
      [standing({ posDepth: 4, targetDepth: 1 })],
      3_000,
    );

    expect(closer.lastProgressAt).toBe(3_000);
    expect(closer.bestDistanceByCargo.get('cargo')).toBe(3);
  });

  it('does not count shuttling back and forth as progress', () => {
    const arrived = afterMoving(
      undefined,
      [standing({ posDepth: 2, targetDepth: 1 })],
      1_000,
    );
    const drifted = afterMoving(
      arrived,
      [standing({ posDepth: 3, targetDepth: 1 })],
      3_000,
    );
    const backAgain = afterMoving(
      drifted,
      [standing({ posDepth: 2, targetDepth: 1 })],
      5_000,
    );

    expect(backAgain.lastProgressAt).toBe(1_000);
    expect(stuckForMs(backAgain, 6_000)).toBe(5_000);
  });

  it('forgets cargos that have left the lane', () => {
    const both = afterMoving(
      undefined,
      [
        standing({ cargoId: 'v7', posDepth: 2 }),
        standing({ cargoId: 'v11', posDepth: 4 }),
      ],
      1_000,
    );
    const alone = afterMoving(
      both,
      [standing({ cargoId: 'v11', posDepth: 4 })],
      2_000,
    );

    expect([...alone.bestDistanceByCargo.keys()]).toEqual(['v11']);
  });
});
