import { toPlantModelSummary } from './plant-model-summary';

describe('toPlantModelSummary', () => {
  it('returns null for non-object values', () => {
    expect(toPlantModelSummary(null)).toBeNull();
    expect(toPlantModelSummary(undefined)).toBeNull();
    expect(toPlantModelSummary('not a model')).toBeNull();
  });

  it('returns null when the value has no string name', () => {
    expect(toPlantModelSummary({})).toBeNull();
    expect(toPlantModelSummary({ name: 123 })).toBeNull();
  });

  it('returns null for the kernel\'s "nothing loaded" sentinel — an empty model named "unnamed"', () => {
    expect(
      toPlantModelSummary({
        name: 'unnamed',
        points: [],
        paths: [],
        vehicles: [],
        locations: [],
      }),
    ).toBeNull();
  });

  it('does not treat a non-empty model literally named "unnamed" as the sentinel', () => {
    expect(
      toPlantModelSummary({
        name: 'unnamed',
        points: [{ name: 'P1' }],
        paths: [],
        vehicles: [],
        locations: [],
      }),
    ).toEqual({
      name: 'unnamed',
      pointCount: 1,
      pathCount: 0,
      vehicleCount: 0,
    });
  });

  it('summarizes a real model, defaulting missing arrays to zero counts', () => {
    expect(
      toPlantModelSummary({
        name: 'factory-a',
        points: [{ name: 'P1' }, { name: 'P2' }],
        paths: [{ name: 'P1---P2' }],
      }),
    ).toEqual({
      name: 'factory-a',
      pointCount: 2,
      pathCount: 1,
      vehicleCount: 0,
    });
  });
});
