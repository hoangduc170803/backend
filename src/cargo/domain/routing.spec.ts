import {
  buildRoadGraph,
  reverseRoadGraph,
  shortestDistancesFrom,
  RoadEdge,
} from './routing';

const twoWay = (from: string, to: string, length: number): RoadEdge => ({
  from,
  to,
  length,
  maxVelocity: 1,
  maxReverseVelocity: 1,
});

const oneWay = (from: string, to: string, length: number): RoadEdge => ({
  from,
  to,
  length,
  maxVelocity: 1,
  maxReverseVelocity: 0,
});

const reverseOnly = (from: string, to: string, length: number): RoadEdge => ({
  from,
  to,
  length,
  maxVelocity: 0,
  maxReverseVelocity: 1,
});

describe('routing', () => {
  describe('buildRoadGraph', () => {
    it('is traversable both ways when the path allows reverse travel', () => {
      const graph = buildRoadGraph([twoWay('A', 'B', 5)]);
      expect(shortestDistancesFrom(graph, 'A').get('B')).toBe(5);
      expect(shortestDistancesFrom(graph, 'B').get('A')).toBe(5);
    });

    it('is traversable forward only when maxReverseVelocity is 0', () => {
      const graph = buildRoadGraph([oneWay('A', 'B', 5)]);
      expect(shortestDistancesFrom(graph, 'A').get('B')).toBe(5);
      expect(shortestDistancesFrom(graph, 'B').has('A')).toBe(false);
    });

    it('is traversable in reverse only when maxVelocity is 0', () => {
      const graph = buildRoadGraph([reverseOnly('A', 'B', 5)]);
      expect(shortestDistancesFrom(graph, 'A').has('B')).toBe(false);
      expect(shortestDistancesFrom(graph, 'B').get('A')).toBe(5);
    });

    it('detours via the two-way loop instead of driving back up a one-way path', () => {
      const graph = buildRoadGraph([
        oneWay('A', 'B', 1),
        twoWay('B', 'C', 10),
        twoWay('C', 'A', 10),
      ]);
      expect(shortestDistancesFrom(graph, 'A').get('B')).toBe(1);
      expect(shortestDistancesFrom(graph, 'B').get('A')).toBe(20);
    });

    it('clamps non-finite or negative lengths to 0', () => {
      const graph = buildRoadGraph([
        twoWay('A', 'B', -3),
        twoWay('B', 'C', Number.NaN),
      ]);
      const dist = shortestDistancesFrom(graph, 'A');
      expect(dist.get('B')).toBe(0);
      expect(dist.get('C')).toBe(0);
    });

    it('skips edges missing an endpoint', () => {
      const graph = buildRoadGraph([twoWay('', 'B', 5)]);
      expect(graph.size).toBe(0);
    });
  });

  describe('reverseRoadGraph', () => {
    it('flips every edge so Dijkstra-from-target yields into-target distance', () => {
      const forward = buildRoadGraph([
        oneWay('A', 'B', 1),
        oneWay('B', 'C', 1),
      ]);
      const intoC = shortestDistancesFrom(reverseRoadGraph(forward), 'C');
      expect(intoC.get('A')).toBe(2);
      expect(intoC.get('B')).toBe(1);
    });

    it('keeps a bidirectional edge bidirectional', () => {
      const forward = buildRoadGraph([twoWay('A', 'B', 4)]);
      const reversed = reverseRoadGraph(forward);
      expect(shortestDistancesFrom(reversed, 'A').get('B')).toBe(4);
      expect(shortestDistancesFrom(reversed, 'B').get('A')).toBe(4);
    });

    it('exposes a vehicle trapped in a one-way pocket as unreachable', () => {
      const forward = buildRoadGraph([
        oneWay('MAIN', 'TRAP', 1),
        twoWay('MAIN', 'PICKUP', 1),
      ]);
      const intoPickup = shortestDistancesFrom(
        reverseRoadGraph(forward),
        'PICKUP',
      );
      expect(intoPickup.get('MAIN')).toBe(1);
      expect(intoPickup.has('TRAP')).toBe(false);
    });

    it('keeps sink-only nodes present as sources in the reversed graph', () => {
      const forward = buildRoadGraph([oneWay('A', 'B', 1)]);
      const reversed = reverseRoadGraph(forward);
      expect(shortestDistancesFrom(reversed, 'B').get('A')).toBe(1);
    });
  });

  describe('shortestDistancesFrom', () => {
    const graph = buildRoadGraph([
      twoWay('A', 'B', 1),
      twoWay('B', 'C', 1),
      twoWay('A', 'C', 5),
    ]);

    it('finds the shortest multi-hop path over a direct longer edge', () => {
      const dist = shortestDistancesFrom(graph, 'A');
      expect(dist.get('A')).toBe(0);
      expect(dist.get('B')).toBe(1);
      expect(dist.get('C')).toBe(2);
    });

    it('returns an empty map for an unknown source', () => {
      expect(shortestDistancesFrom(graph, 'Z').size).toBe(0);
    });

    it('omits unreachable nodes', () => {
      const disjoint = buildRoadGraph([
        twoWay('A', 'B', 1),
        twoWay('X', 'Y', 1),
      ]);
      const dist = shortestDistancesFrom(disjoint, 'A');
      expect(dist.has('X')).toBe(false);
      expect(dist.has('Y')).toBe(false);
    });
  });
});
