import {
  DROPOFF_RETREAT_CELLS,
  RetreatGraph,
  RetreatGraphPath,
  RetreatGraphPoint,
  resolveRetreatPath,
} from './retreat-point';

const point = (name: string, x: number, y: number): RetreatGraphPoint => ({
  name,
  position: { x, y },
});

const bidirectional = (
  srcPointName: string,
  destPointName: string,
): RetreatGraphPath => ({
  srcPointName,
  destPointName,
  maxVelocity: 10000,
  maxReverseVelocity: 10000,
});

const forwardOnly = (
  srcPointName: string,
  destPointName: string,
): RetreatGraphPath => ({
  srcPointName,
  destPointName,
  maxVelocity: 10000,
  maxReverseVelocity: 0,
});

const column: RetreatGraph = {
  points: [
    point('0191', 46000, 1000),
    point('0091', 46000, 0),
    point('3001', 46000, -1000),
    point('3002', 46000, -2000),
    point('3003', 46000, -3000),
  ],
  paths: [
    bidirectional('0191', '0091'),
    bidirectional('0091', '3001'),
    bidirectional('3001', '3002'),
    bidirectional('3002', '3003'),
  ],
};

describe('resolveRetreatPath', () => {
  it('backs two cells straight up the column, one waypoint per cell', () => {
    expect(resolveRetreatPath(column, '3003')).toEqual(['3002', '3001']);
  });

  it('lists the waypoints in travel order, nearest cell first', () => {
    expect(resolveRetreatPath(column, '3003', 3)).toEqual([
      '3002',
      '3001',
      '0091',
    ]);
  });

  it('crosses the aisle when the drop cell is on the top row', () => {
    expect(resolveRetreatPath(column, '3001')).toEqual(['0091', '0191']);
  });

  it('defaults to two cells', () => {
    expect(resolveRetreatPath(column, '3003')).toEqual(
      resolveRetreatPath(column, '3003', DROPOFF_RETREAT_CELLS),
    );
    expect(DROPOFF_RETREAT_CELLS).toBe(2);
  });

  it('honours the cell count: one cell stops one cell back', () => {
    expect(resolveRetreatPath(column, '3003', 1)).toEqual(['3002']);
  });

  it('returns null for an unknown drop point', () => {
    expect(resolveRetreatPath(column, '9999')).toBeNull();
  });

  it('returns null when the column ends before the walk does', () => {
    const topOfGraph: RetreatGraph = {
      points: [point('3001', 46000, -1000), point('3002', 46000, -2000)],
      paths: [bidirectional('3001', '3002')],
    };

    expect(resolveRetreatPath(topOfGraph, '3002')).toBeNull();
  });

  it('returns null when the drop point has nothing behind it at all', () => {
    expect(resolveRetreatPath(column, '0191')).toBeNull();
  });

  it('returns null when the path runs one-way against the retreat', () => {
    const downwardOnly: RetreatGraph = {
      points: column.points,
      paths: [
        forwardOnly('0191', '0091'),
        forwardOnly('0091', '3001'),
        forwardOnly('3001', '3002'),
        forwardOnly('3002', '3003'),
      ],
    };

    expect(resolveRetreatPath(downwardOnly, '3003')).toBeNull();
  });

  it('returns null when only the second hop is one-way against the retreat', () => {
    const secondHopBlocked: RetreatGraph = {
      points: column.points,
      paths: [
        bidirectional('0091', '3001'),
        forwardOnly('3001', '3002'),
        bidirectional('3002', '3003'),
      ],
    };

    expect(resolveRetreatPath(secondHopBlocked, '3003')).toBeNull();
    expect(resolveRetreatPath(secondHopBlocked, '3003', 1)).toEqual(['3002']);
  });

  it('returns null when no path links the cell behind, even though it exists', () => {
    const unlinked: RetreatGraph = {
      points: column.points,
      paths: [bidirectional('3002', '3003')],
    };

    expect(resolveRetreatPath(unlinked, '3003', 1)).toEqual(['3002']);
    expect(resolveRetreatPath(unlinked, '3003', 2)).toBeNull();
  });

  it('never skips over an unreachable cell to a further reachable one', () => {
    const gapJumper: RetreatGraph = {
      points: column.points,
      paths: [bidirectional('3003', '0091')],
    };

    expect(resolveRetreatPath(gapJumper, '3003', 1)).toBeNull();
  });

  it('refuses to step onto a point the walk already visited', () => {
    const duplicateName: RetreatGraph = {
      points: [point('3003', 46000, -3000), point('3003', 46000, -2000)],
      paths: [bidirectional('3003', '3003')],
    };

    expect(resolveRetreatPath(duplicateName, '3003', 1)).toBeNull();
  });

  it('goes straight instead of turning onto a reachable lateral neighbour', () => {
    const branching: RetreatGraph = {
      points: [
        ...column.points,
        point('4002', 45000, -2000),
        point('4001', 45000, -1000),
        point('4091', 45000, 0),
      ],
      paths: [
        ...column.paths,
        bidirectional('3003', '4002'),
        bidirectional('4002', '4001'),
        bidirectional('4001', '4091'),
      ],
    };

    expect(resolveRetreatPath(branching, '3003', 3)).toEqual([
      '3002',
      '3001',
      '0091',
    ]);
  });

  it('stays in its column when a neighbouring column is closer in y', () => {
    const staggered: RetreatGraph = {
      points: [
        ...column.points,
        point('4050', 45000, -2500),
        point('4051', 47000, -2500),
      ],
      paths: [
        ...column.paths,
        bidirectional('3003', '4050'),
        bidirectional('3003', '4051'),
      ],
    };

    expect(resolveRetreatPath(staggered, '3003', 1)).toEqual(['3002']);
  });

  it('does not derive the cell spacing from a constant', () => {
    const wideSpacing: RetreatGraph = {
      points: [
        point('A', 100, -750),
        point('B', 100, -1500),
        point('C', 100, -2250),
      ],
      paths: [bidirectional('A', 'B'), bidirectional('B', 'C')],
    };

    expect(resolveRetreatPath(wideSpacing, 'C', 2)).toEqual(['B', 'A']);
  });

  it('ignores a locked path exactly as the kernel roadmap does', () => {
    const locked: RetreatGraph = {
      points: column.points,
      paths: [
        { ...bidirectional('3002', '3003'), locked: true },
        bidirectional('3001', '3002'),
      ],
    };

    expect(resolveRetreatPath(locked, '3003', 1)).toBeNull();
  });

  it('returns null for a non-positive cell count instead of the drop point', () => {
    expect(resolveRetreatPath(column, '3003', 0)).toBeNull();
    expect(resolveRetreatPath(column, '3003', -1)).toBeNull();
  });

  it('ignores paths with a missing endpoint', () => {
    const broken: RetreatGraph = {
      points: column.points,
      paths: [
        { ...bidirectional('3002', '3003'), srcPointName: undefined },
        bidirectional('3001', '3002'),
      ],
    };

    expect(resolveRetreatPath(broken, '3003', 1)).toBeNull();
  });
});
