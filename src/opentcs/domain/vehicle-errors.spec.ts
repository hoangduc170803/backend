import {
  emptyVehicleErrors,
  hasVehicleErrors,
  parseVehicleErrorTypes,
  toVehicleErrors,
  vehicleErrorsEqual,
  VEHICLE_ERROR_PROPERTY_KEYS,
} from './vehicle-errors';

describe('parseVehicleErrorTypes', () => {
  it('returns an empty list for undefined or empty input', () => {
    expect(parseVehicleErrorTypes(undefined)).toEqual([]);
    expect(parseVehicleErrorTypes('')).toEqual([]);
  });

  it('splits the comma-joined list the VDA5050 driver publishes', () => {
    expect(
      parseVehicleErrorTypes('adapterLostNavigation, noRouteError'),
    ).toEqual(['adapterLostNavigation', 'noRouteError']);
  });

  it('keeps a single error type', () => {
    expect(parseVehicleErrorTypes('laserZoneStop')).toEqual(['laserZoneStop']);
  });

  it('drops blank entries left by trailing separators', () => {
    expect(parseVehicleErrorTypes('a, ,b,')).toEqual(['a', 'b']);
  });
});

describe('toVehicleErrors', () => {
  it('reads both severity properties', () => {
    expect(
      toVehicleErrors({
        [VEHICLE_ERROR_PROPERTY_KEYS.FATAL]: 'adapterLostNavigation',
        [VEHICLE_ERROR_PROPERTY_KEYS.WARNING]: 'noRouteError, laserZoneStop',
      }),
    ).toEqual({
      fatal: ['adapterLostNavigation'],
      warning: ['noRouteError', 'laserZoneStop'],
    });
  });

  it('reads the descriptions the vehicle gave for its errors', () => {
    expect(
      toVehicleErrors({
        [VEHICLE_ERROR_PROPERTY_KEYS.FATAL]: 'eStop',
        [VEHICLE_ERROR_PROPERTY_KEYS.DESCRIPTIONS]:
          '{"eStop":" Emergency stop button is pressed ","orderError":"","x":3}',
      }),
    ).toEqual({
      fatal: ['eStop'],
      warning: [],
      descriptions: { eStop: 'Emergency stop button is pressed' },
    });
  });

  it('ignores a descriptions property that is not a JSON object', () => {
    for (const value of ['not json', '[]', 'null', '"text"', '{}']) {
      expect(
        toVehicleErrors({ [VEHICLE_ERROR_PROPERTY_KEYS.DESCRIPTIONS]: value }),
      ).toEqual(emptyVehicleErrors());
    }
  });

  it('treats a changed description as a change of the errors', () => {
    const pressed = {
      fatal: ['eStop'],
      warning: [],
      descriptions: { eStop: 'a' },
    };
    expect(vehicleErrorsEqual(pressed, { ...pressed })).toBe(true);
    expect(
      vehicleErrorsEqual(pressed, { ...pressed, descriptions: { eStop: 'b' } }),
    ).toBe(false);
    expect(vehicleErrorsEqual(pressed, { fatal: ['eStop'], warning: [] })).toBe(
      false,
    );
  });

  it('returns empty lists when the vehicle carries no properties', () => {
    expect(toVehicleErrors(undefined)).toEqual(emptyVehicleErrors());
    expect(toVehicleErrors({})).toEqual(emptyVehicleErrors());
  });

  it('ignores unrelated properties', () => {
    expect(toVehicleErrors({ 'vda5050:mapId': 'F1' })).toEqual(
      emptyVehicleErrors(),
    );
  });
});

describe('hasVehicleErrors', () => {
  it('is false for an empty or missing snapshot', () => {
    expect(hasVehicleErrors(undefined)).toBe(false);
    expect(hasVehicleErrors(emptyVehicleErrors())).toBe(false);
  });

  it('is true when either severity carries an entry', () => {
    expect(hasVehicleErrors({ fatal: ['x'], warning: [] })).toBe(true);
    expect(hasVehicleErrors({ fatal: [], warning: ['y'] })).toBe(true);
  });
});

describe('vehicleErrorsEqual', () => {
  it('treats undefined and empty as the same', () => {
    expect(vehicleErrorsEqual(undefined, emptyVehicleErrors())).toBe(true);
  });

  it('detects a new error type', () => {
    expect(
      vehicleErrorsEqual(
        { fatal: [], warning: [] },
        { fatal: ['x'], warning: [] },
      ),
    ).toBe(false);
  });

  it('detects a severity move', () => {
    expect(
      vehicleErrorsEqual(
        { fatal: ['x'], warning: [] },
        { fatal: [], warning: ['x'] },
      ),
    ).toBe(false);
  });

  it('is true for identical snapshots', () => {
    expect(
      vehicleErrorsEqual(
        { fatal: ['a'], warning: ['b', 'c'] },
        { fatal: ['a'], warning: ['b', 'c'] },
      ),
    ).toBe(true);
  });
});
