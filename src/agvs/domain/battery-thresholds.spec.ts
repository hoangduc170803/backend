import {
  batteryThresholdError,
  energyBand,
  thresholdsOf,
  DEFAULT_BATTERY_THRESHOLDS,
} from './battery-thresholds';

const T = { critical: 20, good: 50, sufficient: 60, full: 95 };

describe('battery thresholds', () => {
  describe('energyBand', () => {
    it.each([
      [0, 'CRITICAL'],
      [20, 'CRITICAL'],
      [21, 'LOW'],
      [49, 'LOW'],
      [50, 'GOOD'],
      [100, 'GOOD'],
    ])('%i%% is %s', (energy, band) => {
      expect(energyBand(energy, T)).toBe(band);
    });
  });

  describe('batteryThresholdError', () => {
    it('accepts the defaults', () => {
      expect(batteryThresholdError(DEFAULT_BATTERY_THRESHOLDS)).toBeNull();
    });

    it('accepts good below sufficient and good above sufficient', () => {
      expect(batteryThresholdError({ ...T, good: 30 })).toBeNull();
      expect(batteryThresholdError({ ...T, good: 90 })).toBeNull();
    });

    it.each([
      ['critical not below sufficient', { ...T, critical: 60 }],
      ['sufficient above full', { ...T, sufficient: 96 }],
      ['good below critical', { ...T, good: 10 }],
      ['out of range', { ...T, full: 101 }],
      ['not an integer', { ...T, good: 50.5 }],
    ])('rejects %s', (_label, thresholds) => {
      expect(batteryThresholdError(thresholds)).not.toBeNull();
    });
  });

  it('fills missing columns with defaults', () => {
    expect(thresholdsOf({ criticalBatteryThreshold: 15 })).toEqual({
      ...DEFAULT_BATTERY_THRESHOLDS,
      critical: 15,
    });
  });
});
