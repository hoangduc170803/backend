import {
  ParkVehicleCandidate,
  ParkingPoint,
  mustClearChargePoint,
  mustLeaveZone,
  needsParking,
  pickParkingPoint,
} from './parking.policy';

const candidate = (
  overrides: Partial<ParkVehicleCandidate> = {},
): ParkVehicleCandidate => ({
  name: 'Vehicle-0001',
  dispatchEnabled: true,
  ignored: false,
  idleAvailable: true,
  onOrder: false,
  hasActiveTask: false,
  belowCritical: false,
  charging: false,
  currentPosition: 'P-lane',
  ...overrides,
});

const parks = new Set(['PARK-1', 'PARK-2']);

describe('parking.policy', () => {
  describe('needsParking', () => {
    it('accepts an idle, free, localized AGV standing off a park point', () => {
      expect(needsParking(candidate(), parks, false)).toBe(true);
    });

    it('rejects while cargo is waiting to be assigned', () => {
      expect(needsParking(candidate(), parks, true)).toBe(false);
    });

    it('accepts a dispatch-disabled AGV — it can never take the pending cargo', () => {
      expect(
        needsParking(candidate({ dispatchEnabled: false }), parks, true),
      ).toBe(true);
    });

    it.each([
      ['ignored', { ignored: true }],
      ['not idle in FMS', { idleAvailable: false }],
      ['already on an order', { onOrder: true }],
      ['carrying an active task', { hasActiveTask: true }],
      ['below the critical threshold', { belowCritical: true }],
      ['still charging', { charging: true }],
      ['not localized', { currentPosition: null }],
      ['already standing on a park point', { currentPosition: 'PARK-1' }],
    ])('rejects when %s', (_label, overrides) => {
      expect(needsParking(candidate(overrides), parks, false)).toBe(false);
    });
  });

  describe('pickParkingPoint', () => {
    const point = (
      name: string,
      priority: number | null = null,
    ): ParkingPoint => ({
      name,
      priority,
    });

    it('returns null when there are no points', () => {
      expect(pickParkingPoint([], new Map(), new Set())).toBeNull();
    });

    it('picks the nearest point when no priorities are set', () => {
      const picked = pickParkingPoint(
        [point('PARK-far'), point('PARK-near')],
        new Map([
          ['PARK-far', 500],
          ['PARK-near', 10],
        ]),
        new Set(),
      );
      expect(picked?.name).toBe('PARK-near');
    });

    it('lets priority dominate distance (lower value wins)', () => {
      const picked = pickParkingPoint(
        [point('PARK-near', 5), point('PARK-far', 1)],
        new Map([
          ['PARK-near', 10],
          ['PARK-far', 500],
        ]),
        new Set(),
      );
      expect(picked?.name).toBe('PARK-far');
    });

    it('breaks equal priority by nearest distance', () => {
      const picked = pickParkingPoint(
        [point('PARK-far', 1), point('PARK-near', 1)],
        new Map([
          ['PARK-far', 500],
          ['PARK-near', 10],
        ]),
        new Set(),
      );
      expect(picked?.name).toBe('PARK-near');
    });

    it('breaks a full tie by name for determinism', () => {
      const picked = pickParkingPoint(
        [point('PARK-B'), point('PARK-A')],
        new Map([
          ['PARK-B', 42],
          ['PARK-A', 42],
        ]),
        new Set(),
      );
      expect(picked?.name).toBe('PARK-A');
    });

    it('excludes occupied/targeted points', () => {
      const picked = pickParkingPoint(
        [point('PARK-near'), point('PARK-far')],
        new Map([
          ['PARK-near', 10],
          ['PARK-far', 500],
        ]),
        new Set(['PARK-near']),
      );
      expect(picked?.name).toBe('PARK-far');
    });

    it('drops unreachable points (absent from the distance map)', () => {
      const picked = pickParkingPoint(
        [point('PARK-unreachable'), point('PARK-reachable')],
        new Map([['PARK-reachable', 999]]),
        new Set(),
      );
      expect(picked?.name).toBe('PARK-reachable');
    });

    it('returns null when every point is excluded or unreachable', () => {
      const picked = pickParkingPoint(
        [point('PARK-1'), point('PARK-2')],
        new Map([['PARK-1', 10]]),
        new Set(['PARK-1']),
      );
      expect(picked).toBeNull();
    });
  });

  describe('mustClearChargePoint', () => {
    const reserved = new Set(['C1']);

    it('moves an idle AGV off a charge point promised to a critical AGV', () => {
      expect(
        mustClearChargePoint(candidate({ currentPosition: 'C1' }), reserved),
      ).toBe(true);
    });

    it('leaves it alone while it still charges, holds an order or a task', () => {
      for (const overrides of [
        { charging: true },
        { onOrder: true },
        { hasActiveTask: true },
        { ignored: true },
      ]) {
        expect(
          mustClearChargePoint(
            candidate({ currentPosition: 'C1', ...overrides }),
            reserved,
          ),
        ).toBe(false);
      }
    });

    it('ignores charge points nobody is waiting for', () => {
      expect(
        mustClearChargePoint(candidate({ currentPosition: 'C2' }), reserved),
      ).toBe(false);
    });
  });

  describe('mustLeaveZone', () => {
    const zone = new Set(['Z1']);

    it('moves an idle vehicle standing inside a zone lane', () => {
      expect(mustLeaveZone(candidate({ currentPosition: 'Z1' }), zone)).toBe(
        true,
      );
    });

    it('leaves a vehicle that is working, charging, flat or outside the zone', () => {
      for (const overrides of [
        { hasActiveTask: true },
        { onOrder: true },
        { charging: true },
        { belowCritical: true },
        { currentPosition: 'P-lane' },
      ]) {
        expect(
          mustLeaveZone(
            candidate({ currentPosition: 'Z1', ...overrides }),
            zone,
          ),
        ).toBe(false);
      }
    });
  });
});
