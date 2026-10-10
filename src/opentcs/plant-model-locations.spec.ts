import {
  withMemberLocations,
  withoutLocations,
  type MemberLocationSpec,
} from './plant-model-locations';

interface PushedModel {
  locations: Array<Record<string, unknown>>;
}

function kernelWith(model: unknown) {
  let written: unknown = null;
  return {
    pushed: () => written as PushedModel,
    write: (specs: MemberLocationSpec[]) => {
      written = withMemberLocations(model, specs);
    },
  };
}

const modelWith = (locations: Array<Record<string, unknown>>) => ({
  name: 'v7',
  points: [
    { name: '3003', position: { x: 100, y: 200 } },
    { name: '3004', position: { x: 100, y: 1000 } },
  ],
  locations,
});

describe('withMemberLocations', () => {
  it('creates a location with the type the zone asked for', () => {
    const { write, pushed } = kernelWith(modelWith([]));

    write([
      { locationName: 'location_3003', pointName: '3003', type: 'Drop off' },
    ]);

    expect(pushed().locations).toHaveLength(1);
    expect(pushed().locations[0].typeName).toBe('Drop off');
  });

  it('retypes a location the map already holds under the other type', () => {
    const { write, pushed } = kernelWith(
      modelWith([
        {
          name: 'location_3003',
          typeName: 'Pick up',
          links: [{ pointName: '3003', allowedOperations: [] }],
        },
      ]),
    );

    write([
      { locationName: 'location_3003', pointName: '3003', type: 'Drop off' },
    ]);

    expect(pushed().locations).toHaveLength(1);
    expect(pushed().locations[0].typeName).toBe('Drop off');
  });

  it('retypes every member of the zone, not just the first', () => {
    const { write, pushed } = kernelWith(
      modelWith([
        {
          name: 'location_3003',
          typeName: 'Pick up',
          links: [{ pointName: '3003', allowedOperations: [] }],
        },
        {
          name: 'location_3004',
          typeName: 'Pick up',
          links: [{ pointName: '3004', allowedOperations: [] }],
        },
      ]),
    );

    write([
      { locationName: 'location_3003', pointName: '3003', type: 'Drop off' },
      { locationName: 'location_3004', pointName: '3004', type: 'Drop off' },
    ]);

    expect(pushed().locations.map((location) => location.typeName)).toEqual([
      'Drop off',
      'Drop off',
    ]);
  });
});

describe('withoutLocations', () => {
  it('drops only the named locations', () => {
    const next = withoutLocations(
      modelWith([{ name: 'location_3003' }, { name: 'location_3004' }]),
      ['location_3003'],
    ) as unknown as PushedModel;
    expect(next.locations.map((location) => location.name)).toEqual([
      'location_3004',
    ]);
  });

  it('reports nothing to write when no name is given', () => {
    expect(withoutLocations(modelWith([]), [])).toBeNull();
  });
});
