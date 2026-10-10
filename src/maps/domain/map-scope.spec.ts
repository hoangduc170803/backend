import { inMapFilter, resolveMapFilter } from './map-scope';

describe('resolveMapFilter', () => {
  it('defaults to the loaded map', () => {
    expect(resolveMapFilter({}, 'map-a', undefined).ids).toEqual(['map-a']);
  });

  it('returns nothing by default when no map is loaded', () => {
    expect(resolveMapFilter(undefined, null, undefined).ids).toEqual([]);
  });

  it('reads the whole database, legacy rows included, for an unrestricted caller', () => {
    const filter = resolveMapFilter({ scope: 'all' }, 'map-a', undefined);
    expect(filter.ids).toBeNull();
    expect(inMapFilter(filter, null)).toBe(true);
  });

  it('never widens a scoped caller past its own maps, nor to rows without a map', () => {
    const filter = resolveMapFilter({ scope: 'all' }, 'map-a', ['map-b']);
    expect(filter.ids).toEqual(['map-b']);
    expect(inMapFilter(filter, null)).toBe(false);
    expect(resolveMapFilter({}, 'map-a', ['map-b']).ids).toEqual([]);
    expect(
      resolveMapFilter({ mapRecordId: 'map-c' }, 'map-a', ['map-b']).ids,
    ).toEqual([]);
  });

  it('lets a specific map win over the scope', () => {
    expect(
      resolveMapFilter(
        { scope: 'all', mapRecordId: 'map-c' },
        'map-a',
        undefined,
      ).ids,
    ).toEqual(['map-c']);
  });
});
