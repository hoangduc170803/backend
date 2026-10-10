import { batteryVoltageOf } from './vehicle-telemetry';

describe('batteryVoltageOf', () => {
  it('reads the voltage the kernel stamps on the vehicle', () => {
    expect(batteryVoltageOf({ 'fms:batteryVoltage': '48.3' })).toBe(48.3);
  });

  it.each([
    [undefined],
    [{}],
    [{ 'fms:batteryVoltage': '' }],
    [{ 'fms:batteryVoltage': 'n/a' }],
    [{ 'fms:batteryVoltage': '0.0' }],
  ])(
    'is null when the vehicle reports no usable voltage (%j)',
    (properties) => {
      expect(batteryVoltageOf(properties)).toBeNull();
    },
  );
});
