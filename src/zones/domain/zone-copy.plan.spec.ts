import { planZoneCopy } from './zone-copy.plan';

const target = (over: Partial<Parameters<typeof planZoneCopy>[1]> = {}) => ({
  pointNames: new Set(['P1', 'P2', 'P3', 'P4']),
  takenNames: new Set<string>(),
  takenLocations: new Set<string>(),
  ...over,
});

describe('planZoneCopy', () => {
  it('accepts zones whose points all exist on the target map', () => {
    const plan = planZoneCopy(
      [
        {
          id: 'a',
          name: 'Z1',
          memberLocationNames: ['location_P1', 'location_P2'],
        },
      ],
      target(),
    );
    expect(plan.accepted.map((z) => z.id)).toEqual(['a']);
    expect(plan.skipped).toEqual([]);
  });

  it('skips a zone with a point missing on the target map', () => {
    const plan = planZoneCopy(
      [
        {
          id: 'a',
          name: 'Z1',
          memberLocationNames: ['location_P1', 'location_X9'],
        },
      ],
      target(),
    );
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped[0].reason).toContain('X9');
  });

  it('skips name and location clashes, including within the same batch', () => {
    const plan = planZoneCopy(
      [
        { id: 'a', name: 'Taken', memberLocationNames: ['location_P1'] },
        { id: 'b', name: 'Z2', memberLocationNames: ['location_P2'] },
        { id: 'c', name: 'Z2', memberLocationNames: ['location_P3'] },
        { id: 'd', name: 'Z4', memberLocationNames: ['location_P2'] },
        { id: 'e', name: 'Z5', memberLocationNames: ['location_P4'] },
      ],
      target({
        takenNames: new Set(['Taken']),
        takenLocations: new Set(['location_P4']),
      }),
    );
    expect(plan.accepted.map((z) => z.id)).toEqual(['b']);
    expect(plan.skipped.map((s) => s.sourceId)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('skips zones rejected by the extra check and empty zones', () => {
    const plan = planZoneCopy(
      [
        { id: 'a', name: 'Z1', memberLocationNames: [] },
        { id: 'b', name: 'S1', memberLocationNames: ['location_P1'] },
      ],
      target({ extraProblem: (s) => (s.id === 'b' ? 'unreachable' : null) }),
    );
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'Khu vực không có vị trí nào.',
      'unreachable',
    ]);
  });
});
