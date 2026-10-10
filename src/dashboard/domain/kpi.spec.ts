import {
  bucketUnitFor,
  failureRate,
  isKpiWindow,
  roundSeconds,
  roundTo,
  successRate,
  terminalTotal,
} from './kpi';

describe('kpi domain', () => {
  describe('bucketUnitFor', () => {
    it('buckets the day-scale window by day', () => {
      expect(bucketUnitFor('7d')).toBe('day');
    });

    it('buckets the intraday windows by hour', () => {
      expect(bucketUnitFor('today')).toBe('hour');
      expect(bucketUnitFor('24h')).toBe('hour');
    });
  });

  describe('isKpiWindow', () => {
    it('accepts the supported windows', () => {
      expect(isKpiWindow('today')).toBe(true);
      expect(isKpiWindow('7d')).toBe(true);
    });

    it('rejects anything else', () => {
      expect(isKpiWindow('30d')).toBe(false);
      expect(isKpiWindow(undefined)).toBe(false);
    });
  });

  describe('rates', () => {
    it('counts cancellations as failures against the terminal total', () => {
      const counts = { completed: 6, failed: 3, cancelled: 1 };
      expect(terminalTotal(counts)).toBe(10);
      expect(failureRate(counts)).toBe(0.4);
      expect(successRate(counts)).toBe(0.6);
    });

    it('is null when nothing reached a terminal state', () => {
      const counts = { completed: 0, failed: 0, cancelled: 0 };
      expect(failureRate(counts)).toBeNull();
      expect(successRate(counts)).toBeNull();
    });

    it('is 0 when every task completed', () => {
      expect(failureRate({ completed: 4, failed: 0, cancelled: 0 })).toBe(0);
      expect(successRate({ completed: 4, failed: 0, cancelled: 0 })).toBe(1);
    });

    it('is 1 when nothing completed', () => {
      expect(failureRate({ completed: 0, failed: 2, cancelled: 1 })).toBe(1);
      expect(successRate({ completed: 0, failed: 2, cancelled: 1 })).toBe(0);
    });

    it('keeps four decimals of resolution', () => {
      expect(failureRate({ completed: 2, failed: 1, cancelled: 0 })).toBe(
        0.3333,
      );
    });
  });

  describe('rounding', () => {
    it('rounds to the requested precision', () => {
      expect(roundTo(1.23456, 2)).toBe(1.23);
      expect(roundTo(0.6666, 2)).toBe(0.67);
    });

    it('rounds seconds to whole numbers and passes null through', () => {
      expect(roundSeconds(12.6)).toBe(13);
      expect(roundSeconds(null)).toBeNull();
    });
  });
});
