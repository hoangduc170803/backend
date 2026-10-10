import { resolveBackfillMatch } from './map-record-backfill';

describe('resolveBackfillMatch', () => {
  it('leaves equal latest timestamps unresolved regardless of candidate order', () => {
    const rows = [
      { id: 'a', lastLoadedAt: new Date(1) },
      { id: 'b', lastLoadedAt: new Date(1) },
    ];
    expect(resolveBackfillMatch(rows)).toBeNull();
    expect(resolveBackfillMatch([...rows].reverse())).toBeNull();
  });
  it('returns null with no candidates', () => {
    expect(resolveBackfillMatch([])).toBeNull();
  });

  it('resolves a single candidate directly, loaded or not', () => {
    expect(resolveBackfillMatch([{ id: 'a', lastLoadedAt: null }])).toBe('a');
  });

  it('leaves it unresolved when several same-named records were never loaded — the real "v7-vda5050" case', () => {
    const candidates = [
      { id: 'a', lastLoadedAt: null },
      { id: 'b', lastLoadedAt: null },
      { id: 'c', lastLoadedAt: null },
    ];
    expect(resolveBackfillMatch(candidates)).toBeNull();
  });

  it('picks the one candidate that was ever loaded — the real "MapTestRCS" case', () => {
    const candidates = [
      { id: 'loaded', lastLoadedAt: new Date('2026-09-14T06:15:59Z') },
      { id: 'never', lastLoadedAt: null },
    ];
    expect(resolveBackfillMatch(candidates)).toBe('loaded');
  });

  it('prefers the most recently loaded when several were loaded', () => {
    const candidates = [
      { id: 'older', lastLoadedAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'newer', lastLoadedAt: new Date('2026-06-01T00:00:00Z') },
      { id: 'never', lastLoadedAt: null },
    ];
    expect(resolveBackfillMatch(candidates)).toBe('newer');
  });
});
