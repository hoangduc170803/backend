import {
  planZoneSync,
  withRebuildsFailed,
  type KernelShape,
  type SyncCandidate,
} from './zone-sync.policy';

const zone = (
  id: string,
  status: 'ACTIVE' | 'STALE',
  ...points: string[]
): SyncCandidate => ({
  id,
  status,
  memberLocationNames: points.map((point) => `location_${point}`),
});

function kernelWith(...points: string[]): KernelShape {
  return {
    pointNames: new Set(points),
    locationLinks: new Map(
      points.map((point) => [`location_${point}`, new Set([point])]),
    ),
  };
}

describe('planZoneSync', () => {
  it('keeps a zone whose cells all exist and match the kernel', () => {
    const plan = planZoneSync(
      [zone('z1', 'ACTIVE', 'P1', 'P2')],
      kernelWith('P1', 'P2'),
    );

    expect(plan.desiredStatus.get('z1')).toBe('ACTIVE');
    expect(plan.rebuildIds.size).toBe(0);
  });

  it('rebuilds a zone the kernel has forgotten, without demoting it', () => {
    const kernel: KernelShape = {
      pointNames: new Set(['P1']),
      locationLinks: new Map(),
    };

    const plan = planZoneSync([zone('z1', 'ACTIVE', 'P1')], kernel);

    expect(plan.desiredStatus.get('z1')).toBe('ACTIVE');
    expect([...plan.rebuildIds]).toEqual(['z1']);
  });

  it('rebuilds a zone whose location points at the wrong cell', () => {
    const kernel: KernelShape = {
      pointNames: new Set(['P1']),
      locationLinks: new Map([['location_P1', new Set(['somewhere-else'])]]),
    };

    expect([
      ...planZoneSync([zone('z1', 'ACTIVE', 'P1')], kernel).rebuildIds,
    ]).toEqual(['z1']);
  });

  it('drops a zone whose cells are gone from the map', () => {
    const plan = planZoneSync([zone('z1', 'ACTIVE', 'P9')], kernelWith('P1'));

    expect(plan.desiredStatus.get('z1')).toBe('STALE');
    expect(plan.rebuildIds.size).toBe(0);
  });

  it('drops a zone with no cells at all', () => {
    const plan = planZoneSync([zone('z1', 'ACTIVE')], kernelWith('P1'));

    expect(plan.desiredStatus.get('z1')).toBe('STALE');
  });

  it('drops both zones when two live ones claim the same cell', () => {
    const plan = planZoneSync(
      [zone('z1', 'ACTIVE', 'P1'), zone('z2', 'ACTIVE', 'P1', 'P2')],
      kernelWith('P1', 'P2'),
    );

    expect(plan.desiredStatus.get('z1')).toBe('STALE');
    expect(plan.desiredStatus.get('z2')).toBe('STALE');
  });

  it('lets the live zone keep a cell a stale one also lists', () => {
    const plan = planZoneSync(
      [zone('z1', 'ACTIVE', 'P1'), zone('z2', 'STALE', 'P1')],
      kernelWith('P1'),
    );

    expect(plan.desiredStatus.get('z1')).toBe('ACTIVE');
    expect(plan.desiredStatus.get('z2')).toBe('STALE');
  });

  it('never brings a stale zone back, even when its cells are all fine', () => {
    const plan = planZoneSync([zone('z1', 'STALE', 'P1')], kernelWith('P1'));

    expect(plan.desiredStatus.get('z1')).toBe('STALE');
  });
});

describe('withRebuildsFailed', () => {
  it('demotes exactly the zones whose rebuild the kernel refused', () => {
    const kernel: KernelShape = {
      pointNames: new Set(['P1', 'P2']),
      locationLinks: new Map([['location_P2', new Set(['P2'])]]),
    };
    const plan = planZoneSync(
      [
        zone('needs-rebuild', 'ACTIVE', 'P1'),
        zone('already-fine', 'ACTIVE', 'P2'),
      ],
      kernel,
    );

    const after = withRebuildsFailed(plan);

    expect(after.desiredStatus.get('needs-rebuild')).toBe('STALE');
    expect(after.desiredStatus.get('already-fine')).toBe('ACTIVE');
  });

  it('leaves the original plan untouched', () => {
    const plan = planZoneSync([zone('z1', 'ACTIVE', 'P1')], {
      pointNames: new Set(['P1']),
      locationLinks: new Map(),
    });

    withRebuildsFailed(plan);

    expect(plan.desiredStatus.get('z1')).toBe('ACTIVE');
  });
});
