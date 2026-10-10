import { CorridorPath, detectSingleVehicleBlocks } from './corridor-detector';

/** Build a bidirectional edge as the two path objects OpenTCS stores for a
    reversible lane (fwd + rev), named in the "A --- B" convention. */
function biEdge(a: string, b: string): CorridorPath[] {
  return [
    { name: `${a} --- ${b}`, srcPointName: a, destPointName: b },
    { name: `${b} --- ${a}`, srcPointName: b, destPointName: a },
  ];
}

/** One-way edge a -> b (single path object). */
function oneWay(a: string, b: string): CorridorPath {
  return { name: `${a} --- ${b}`, srcPointName: a, destPointName: b };
}

describe('detectSingleVehicleBlocks', () => {
  it('wraps a dead-end lane (junction - interiors - dead-end) in one block, INCLUDING the mouth junction', () => {
    // J is a junction (also connects to two aisle points A1, A2 so deg(J)=3).
    // Lane: J - p1 - p2 - p3(dead-end).
    const paths: CorridorPath[] = [
      ...biEdge('J', 'A1'),
      ...biEdge('J', 'A2'),
      ...biEdge('J', 'p1'),
      ...biEdge('p1', 'p2'),
      ...biEdge('p2', 'p3'),
    ];

    const blocks = detectSingleVehicleBlocks(paths);
    // Aisle A1-A2 are 1-point spurs off J (no interior) -> not blocked.
    const lane = blocks.find((b) => b.memberNames.includes('p3'));
    expect(lane).toBeDefined();
    expect(lane!.type).toBe('SINGLE_VEHICLE_ONLY');
    // Interior + dead-end + the mouth junction J are all members (J must be in
    // the block so a waiting vehicle cannot camp on the lane's sole exit).
    expect(lane!.memberNames).toEqual(
      expect.arrayContaining(['J', 'p1', 'p2', 'p3']),
    );
    // Both path directions for every lane segment, incl. the J->p1 entry path.
    expect(lane!.memberNames).toEqual(
      expect.arrayContaining([
        'J --- p1',
        'p1 --- J',
        'p1 --- p2',
        'p2 --- p1',
        'p2 --- p3',
        'p3 --- p2',
      ]),
    );
  });

  it('models the real pickup column 0149-0159-0169-0179 dead-end as a single block', () => {
    // Aisle junction 0139 (deg 3: to 0129, to 0149, and a cross aisle 0138),
    // then the single-file column up to the dead-end 0179.
    const paths: CorridorPath[] = [
      ...biEdge('0139', '0129'),
      ...biEdge('0139', '0138'),
      ...biEdge('0139', '0149'),
      ...biEdge('0149', '0159'),
      ...biEdge('0159', '0169'),
      ...biEdge('0169', '0179'),
    ];

    const blocks = detectSingleVehicleBlocks(paths);
    const lane = blocks.find((b) => b.memberNames.includes('0179'));
    expect(lane).toBeDefined();
    expect(lane!.memberNames).toEqual(
      expect.arrayContaining(['0139', '0149', '0159', '0169', '0179']),
    );
    // The mouth junction 0139 is included so a waiting vehicle can't camp on it.
    expect(lane!.memberNames).toContain('0139');
  });

  it('does NOT block a through corridor between two junctions (no dead-end)', () => {
    // jA (deg 3) - x - y - jB (deg 3). A single-file aisle with both ends open
    // is left to the base scheduler under the dead-end-only policy.
    const paths: CorridorPath[] = [
      ...biEdge('jA', 'a1'),
      ...biEdge('jA', 'a2'),
      ...biEdge('jA', 'x'),
      ...biEdge('x', 'y'),
      ...biEdge('y', 'jB'),
      ...biEdge('jB', 'b1'),
      ...biEdge('jB', 'b2'),
    ];
    expect(detectSingleVehicleBlocks(paths)).toEqual([]);
  });

  it('produces NO blocks for a 2D grid (every interior node has degree 4)', () => {
    // 3x3 grid: center has degree 4, edges degree 3, corners degree 2.
    // Corners are degree-2 but their neighbours are degree-3 boundaries with no
    // interior between -> no corridor with an interior node.
    const pts = [
      ['00', '01', '02'],
      ['10', '11', '12'],
      ['20', '21', '22'],
    ];
    const paths: CorridorPath[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (c + 1 < 3) paths.push(...biEdge(pts[r][c], pts[r][c + 1]));
        if (r + 1 < 3) paths.push(...biEdge(pts[r][c], pts[r + 1][c]));
      }
    }
    expect(detectSingleVehicleBlocks(paths)).toEqual([]);
  });

  it('does NOT block a single-point dead-end spur (a point is its own mutex)', () => {
    // J (deg 3) - s(dead-end). No interior node -> not a corridor.
    const paths: CorridorPath[] = [
      ...biEdge('J', 'a1'),
      ...biEdge('J', 'a2'),
      ...biEdge('J', 's'),
    ];
    expect(detectSingleVehicleBlocks(paths)).toEqual([]);
  });

  it('does NOT block a bare junction-junction edge', () => {
    // Two junctions directly connected, each also connected to two spurs.
    const paths: CorridorPath[] = [
      ...biEdge('jA', 'a1'),
      ...biEdge('jA', 'a2'),
      ...biEdge('jA', 'jB'),
      ...biEdge('jB', 'b1'),
      ...biEdge('jB', 'b2'),
    ];
    expect(detectSingleVehicleBlocks(paths)).toEqual([]);
  });

  it('handles a one-way single-file chain (no reverse paths) as a corridor', () => {
    // Junction fan-out then a strictly one-way chain J -> p1 -> p2 -> p3(end).
    const paths: CorridorPath[] = [
      ...biEdge('J', 'a1'),
      ...biEdge('J', 'a2'),
      oneWay('J', 'p1'),
      oneWay('p1', 'p2'),
      oneWay('p2', 'p3'),
    ];
    const blocks = detectSingleVehicleBlocks(paths);
    const lane = blocks.find((b) => b.memberNames.includes('p3'));
    expect(lane).toBeDefined();
    expect(lane!.memberNames).toEqual(
      expect.arrayContaining(['p1', 'p2', 'p3', 'J --- p1', 'p1 --- p2']),
    );
  });

  it('excludes locked paths from the topology', () => {
    // The lane segment p2-p3 is locked, so p3 is unreachable -> the corridor is
    // only J - p1 - p2 with p2 now a dead-end.
    const paths: CorridorPath[] = [
      ...biEdge('J', 'a1'),
      ...biEdge('J', 'a2'),
      ...biEdge('J', 'p1'),
      ...biEdge('p1', 'p2'),
      {
        name: 'p2 --- p3',
        srcPointName: 'p2',
        destPointName: 'p3',
        locked: true,
      },
      {
        name: 'p3 --- p2',
        srcPointName: 'p3',
        destPointName: 'p2',
        locked: true,
      },
    ];
    const blocks = detectSingleVehicleBlocks(paths);
    expect(blocks.some((b) => b.memberNames.includes('p3'))).toBe(false);
    const lane = blocks.find((b) => b.memberNames.includes('p2'));
    expect(lane).toBeDefined();
    expect(lane!.memberNames).toContain('p1');
  });

  it('does NOT block an all-degree-2 ring (no dead-end)', () => {
    // a - b - c - a, every node degree 2. A ring has no dead-end tip, so under
    // the dead-end-only policy it is left to the base scheduler.
    const paths: CorridorPath[] = [
      ...biEdge('a', 'b'),
      ...biEdge('b', 'c'),
      ...biEdge('c', 'a'),
    ];
    expect(detectSingleVehicleBlocks(paths)).toEqual([]);
  });

  it('is deterministic and gives unique block names', () => {
    const paths: CorridorPath[] = [
      ...biEdge('J', 'a1'),
      ...biEdge('J', 'a2'),
      ...biEdge('J', 'p1'),
      ...biEdge('p1', 'p2'),
      ...biEdge('p2', 'p3'),
    ];
    const a = detectSingleVehicleBlocks(paths);
    const b = detectSingleVehicleBlocks(paths);
    expect(a).toEqual(b);
    const names = a.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
