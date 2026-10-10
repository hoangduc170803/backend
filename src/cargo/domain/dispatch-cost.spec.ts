import {
  WEIGHT_MAX,
  batteryCost,
  clamp01,
  clampWeight,
  nonNegativeOr,
} from './dispatch-cost';

describe('dispatch-cost', () => {
  describe('clamp01', () => {
    it.each([
      [0.5, 0.5],
      [0, 0],
      [1, 1],
      [-0.3, 0],
      [1.7, 1],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, 0],
    ])('clamps %p to %p', (input, expected) => {
      expect(clamp01(input)).toBe(expected);
    });
  });

  describe('clampWeight', () => {
    it.each([
      [3, 3],
      [0, 0],
      [-1, 0],
      [WEIGHT_MAX + 5, WEIGHT_MAX],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
    ])('clamps %p to %p', (input, expected) => {
      expect(clampWeight(input)).toBe(expected);
    });
  });

  describe('nonNegativeOr', () => {
    it.each([
      [5, 9, 5],
      [0, 9, 0],
      [-2, 9, 9],
      [Number.NaN, 9, 9],
    ])('nonNegativeOr(%p, %p) = %p', (value, fallback, expected) => {
      expect(nonNegativeOr(value, fallback)).toBe(expected);
    });
  });

  describe('batteryCost', () => {
    it('equals raw distance when the battery weight is 0', () => {
      expect(batteryCost(1234, 15, 0)).toBe(1234);
      expect(batteryCost(1234, 100, 0)).toBe(1234);
    });

    it('equals raw distance for a full battery regardless of weight', () => {
      expect(batteryCost(1000, 100, 5)).toBe(1000);
    });

    it('penalises long trips for low-battery vehicles', () => {
      expect(batteryCost(1000, 0, 1)).toBe(2000);
      expect(batteryCost(1000, 50, 1)).toBe(1500);
      expect(batteryCost(1000, 50, 2)).toBe(2000);
    });

    it('is zero at zero distance — battery never matters when already there', () => {
      expect(batteryCost(0, 1, 10)).toBe(0);
    });

    it('stays finite and non-negative on garbage battery input', () => {
      for (const energy of [Number.NaN, -50, 400, Number.POSITIVE_INFINITY]) {
        const cost = batteryCost(1000, energy, 5);
        expect(Number.isFinite(cost)).toBe(true);
        expect(cost).toBeGreaterThanOrEqual(0);
      }
    });

    it('never lowers the cost below the raw distance', () => {
      for (const energy of [0, 30, 70, 100]) {
        for (const weight of [0, 1, 5, 10]) {
          expect(batteryCost(777, energy, weight)).toBeGreaterThanOrEqual(777);
        }
      }
    });
  });
});
