import {
  ChargeLocation,
  ChargeVehicleCandidate,
  needsCharging,
  wantsOpportunisticCharge,
  isReleaseCandidate,
  shouldRelease,
  pickSlotDonor,
  isRecallableForWork,
  pickChargeLocation,
} from './charge.policy';

const candidate = (
  overrides: Partial<ChargeVehicleCandidate> = {},
): ChargeVehicleCandidate => ({
  name: 'V1',
  ignored: false,
  dispatchEnabled: true,
  idleAvailable: true,
  enRouteToPark: false,
  charging: false,
  onOrder: false,
  hasActiveTask: false,
  currentPosition: 'P1',
  energyLevel: 15,
  thresholds: { critical: 20, good: 50, sufficient: 60, full: 95 },
  ...overrides,
});

const CHARGE_POINTS = new Set(['C1', 'C2', 'C3']);

describe('charge.policy', () => {
  describe('needsCharging', () => {
    it('is true for an idle, localized AGV at or below critical, off a charge point', () => {
      expect(needsCharging(candidate(), CHARGE_POINTS)).toBe(true);
    });

    it('is true exactly at the critical threshold (<=)', () => {
      expect(needsCharging(candidate({ energyLevel: 20 }), CHARGE_POINTS)).toBe(
        true,
      );
    });

    it('is false above the critical threshold', () => {
      expect(needsCharging(candidate({ energyLevel: 21 }), CHARGE_POINTS)).toBe(
        false,
      );
    });

    it('is true for a critical AGV that is driving to a park point', () => {
      expect(
        needsCharging(
          candidate({
            idleAvailable: false,
            onOrder: true,
            enRouteToPark: true,
          }),
          CHARGE_POINTS,
        ),
      ).toBe(true);
    });

    it('is false when ignored, busy on another order, or unlocalized', () => {
      expect(needsCharging(candidate({ ignored: true }), CHARGE_POINTS)).toBe(
        false,
      );
      expect(
        needsCharging(candidate({ idleAvailable: false }), CHARGE_POINTS),
      ).toBe(false);
      expect(needsCharging(candidate({ onOrder: true }), CHARGE_POINTS)).toBe(
        false,
      );
      expect(
        needsCharging(candidate({ currentPosition: null }), CHARGE_POINTS),
      ).toBe(false);
    });

    it('is false while a task is still running, even if idle and low', () => {
      expect(
        needsCharging(candidate({ hasActiveTask: true }), CHARGE_POINTS),
      ).toBe(false);
    });

    it('is false when already standing on a charge point', () => {
      expect(
        needsCharging(candidate({ currentPosition: 'C2' }), CHARGE_POINTS),
      ).toBe(false);
    });
  });

  describe('wantsOpportunisticCharge', () => {
    it('is true between critical and good with no waiting work', () => {
      expect(
        wantsOpportunisticCharge(
          candidate({ energyLevel: 49 }),
          CHARGE_POINTS,
          false,
        ),
      ).toBe(true);
    });

    it('is false at good, at critical, while work waits, or while parking', () => {
      expect(
        wantsOpportunisticCharge(
          candidate({ energyLevel: 50 }),
          CHARGE_POINTS,
          false,
        ),
      ).toBe(false);
      expect(
        wantsOpportunisticCharge(
          candidate({ energyLevel: 20 }),
          CHARGE_POINTS,
          false,
        ),
      ).toBe(false);
      expect(
        wantsOpportunisticCharge(
          candidate({ energyLevel: 40 }),
          CHARGE_POINTS,
          true,
        ),
      ).toBe(false);
      expect(
        wantsOpportunisticCharge(
          candidate({
            energyLevel: 40,
            idleAvailable: false,
            onOrder: true,
            enRouteToPark: true,
          }),
          CHARGE_POINTS,
          false,
        ),
      ).toBe(false);
    });
  });

  describe('isReleaseCandidate', () => {
    it('is true for a charging AGV not on a new order', () => {
      expect(isReleaseCandidate(candidate({ charging: true }))).toBe(true);
    });

    it('is false when not charging or already on an order', () => {
      expect(isReleaseCandidate(candidate({ charging: false }))).toBe(false);
      expect(
        isReleaseCandidate(candidate({ charging: true, onOrder: true })),
      ).toBe(false);
    });
  });

  describe('shouldRelease', () => {
    it('is true at or above the vehicle full threshold', () => {
      expect(shouldRelease(candidate({ energyLevel: 95 }))).toBe(true);
      expect(shouldRelease(candidate({ energyLevel: 99 }))).toBe(true);
    });

    it('is false below the vehicle full threshold', () => {
      expect(shouldRelease(candidate({ energyLevel: 94 }))).toBe(false);
    });
  });

  describe('pickSlotDonor', () => {
    it('picks the fullest charging AGV at or above its own sufficient threshold', () => {
      const donor = pickSlotDonor([
        candidate({ name: 'A', charging: true, energyLevel: 65 }),
        candidate({ name: 'B', charging: true, energyLevel: 80 }),
        candidate({ name: 'C', charging: true, energyLevel: 59 }),
      ]);
      expect(donor?.name).toBe('B');
    });

    it('skips AGVs below sufficient, busy, or not charging', () => {
      expect(
        pickSlotDonor([
          candidate({ charging: true, energyLevel: 59 }),
          candidate({ charging: true, energyLevel: 90, hasActiveTask: true }),
          candidate({ charging: false, energyLevel: 90 }),
        ]),
      ).toBeNull();
    });
  });

  describe('isRecallableForWork', () => {
    it('is true at or above good for a dispatchable AGV', () => {
      expect(isRecallableForWork(candidate({ energyLevel: 50 }))).toBe(true);
    });

    it('is false below good, when ignored or when dispatch is off', () => {
      expect(isRecallableForWork(candidate({ energyLevel: 49 }))).toBe(false);
      expect(
        isRecallableForWork(candidate({ energyLevel: 90, ignored: true })),
      ).toBe(false);
      expect(
        isRecallableForWork(
          candidate({ energyLevel: 90, dispatchEnabled: false }),
        ),
      ).toBe(false);
    });
  });

  describe('pickChargeLocation', () => {
    const locations: ChargeLocation[] = [
      { name: 'Area 1', points: ['C1', 'C2'] },
      { name: 'Area 2', points: ['C3'] },
    ];
    const allFree = new Map([
      ['Area 1', 2],
      ['Area 2', 1],
    ]);

    it('picks the location whose nearest member point is closest', () => {
      const distances = new Map([
        ['C1', 50],
        ['C2', 40],
        ['C3', 30],
      ]);
      expect(pickChargeLocation(locations, distances, allFree)?.name).toBe(
        'Area 2',
      );
    });

    it('uses the minimum over a location member points', () => {
      const distances = new Map([
        ['C1', 10],
        ['C2', 99],
        ['C3', 20],
      ]);
      expect(pickChargeLocation(locations, distances, allFree)?.name).toBe(
        'Area 1',
      );
    });

    it('drops unreachable locations and returns null when none reachable', () => {
      expect(pickChargeLocation(locations, new Map(), allFree)).toBeNull();
    });

    it('breaks ties by location name', () => {
      const distances = new Map([
        ['C1', 30],
        ['C3', 30],
      ]);
      expect(pickChargeLocation(locations, distances, allFree)?.name).toBe(
        'Area 1',
      );
    });

    it('skips a location with no free slot', () => {
      const distances = new Map([
        ['C1', 50],
        ['C2', 40],
        ['C3', 30],
      ]);
      const freeSlots = new Map([
        ['Area 1', 2],
        ['Area 2', 0],
      ]);
      expect(pickChargeLocation(locations, distances, freeSlots)?.name).toBe(
        'Area 1',
      );
    });

    it('returns null when every location is full', () => {
      const distances = new Map([
        ['C1', 30],
        ['C3', 30],
      ]);
      const freeSlots = new Map([
        ['Area 1', 0],
        ['Area 2', 0],
      ]);
      expect(pickChargeLocation(locations, distances, freeSlots)).toBeNull();
    });
  });
});
