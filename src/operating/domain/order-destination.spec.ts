import { resolveOrderDestination } from './order-destination';

describe('resolveOrderDestination', () => {
  const locations = [
    { name: 'location_P1', type: 'Charging', pointNames: ['P1'] },
    { name: 'location_P2', type: 'Pick up', pointNames: ['P2'] },
  ];
  const locationTypes = [
    { name: 'Charging', allowedOperations: ['Charge'] },
    { name: 'Pick up', allowedOperations: ['liftUp'] },
  ];

  it('passes a point through unchanged for MOVE', () => {
    expect(
      resolveOrderDestination('P3', 'MOVE', locations, locationTypes),
    ).toBe('P3');
  });

  it('resolves NOP at a point to the Location linked there, whatever its type', () => {
    expect(resolveOrderDestination('P2', 'NOP', locations, locationTypes)).toBe(
      'location_P2',
    );
  });

  it('returns null for NOP at a point no Location is linked to', () => {
    expect(
      resolveOrderDestination('P3', 'NOP', locations, locationTypes),
    ).toBeNull();
  });

  it('resolves a point + real action to the Location at that point supporting it', () => {
    expect(
      resolveOrderDestination('P1', 'Charge', locations, locationTypes),
    ).toBe('location_P1');
  });

  it('returns null when no Location at the point supports the requested action', () => {
    expect(
      resolveOrderDestination('P1', 'liftUp', locations, locationTypes),
    ).toBeNull();
  });

  it('returns null for an unknown point entirely', () => {
    expect(
      resolveOrderDestination('P99', 'Charge', locations, locationTypes),
    ).toBeNull();
  });

  it('passes a real Location name through unchanged, bypassing point resolution', () => {
    expect(
      resolveOrderDestination(
        'location_P2',
        'liftUp',
        locations,
        locationTypes,
      ),
    ).toBe('location_P2');
  });

  it('does not let a Location name matching MOVE/NOP short-circuit past the point-passthrough case incorrectly', () => {
    // MOVE always wins first regardless of whether the name happens to be a real Location too.
    expect(
      resolveOrderDestination('location_P1', 'MOVE', locations, locationTypes),
    ).toBe('location_P1');
  });
});
