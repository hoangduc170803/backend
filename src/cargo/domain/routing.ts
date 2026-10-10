export interface RoadEdge {
  readonly from: string;
  readonly to: string;
  readonly length: number;
  readonly maxVelocity: number;
  readonly maxReverseVelocity: number;
}

export type RoadGraph = ReadonlyMap<
  string,
  ReadonlyArray<{ to: string; length: number }>
>;

function nonNegativeLength(length: number): number {
  return Number.isFinite(length) && length > 0 ? length : 0;
}

export function buildRoadGraph(edges: readonly RoadEdge[]): RoadGraph {
  const graph = new Map<string, Array<{ to: string; length: number }>>();
  const arcsFrom = (point: string): Array<{ to: string; length: number }> => {
    const existing = graph.get(point);
    if (existing) return existing;
    const created: Array<{ to: string; length: number }> = [];
    graph.set(point, created);
    return created;
  };

  for (const edge of edges) {
    if (!edge.from || !edge.to) continue;
    const length = nonNegativeLength(edge.length);
    const forwardArcs = arcsFrom(edge.from);
    const reverseArcs = arcsFrom(edge.to);
    if (edge.maxVelocity > 0) forwardArcs.push({ to: edge.to, length });
    if (edge.maxReverseVelocity > 0)
      reverseArcs.push({ to: edge.from, length });
  }
  return graph;
}

/**
 * Flip every edge. Dijkstra FROM a target on the reversed graph yields each
 * point's driving distance TO that target on the original directed graph —
 * the vehicle→pickup cost the assignment engine needs.
 */
export function reverseRoadGraph(graph: RoadGraph): RoadGraph {
  const reversed = new Map<string, Array<{ to: string; length: number }>>();
  for (const node of graph.keys()) reversed.set(node, []);
  for (const [from, edges] of graph) {
    for (const edge of edges) {
      const list = reversed.get(edge.to);
      if (list) list.push({ to: from, length: edge.length });
      else reversed.set(edge.to, [{ to: from, length: edge.length }]);
    }
  }
  return reversed;
}

/**
 * Dijkstra single-source shortest path. Returns the distance from `source` to
 * every reachable node (source included, at 0). Unreachable nodes are absent —
 * callers treat "absent" as unreachable (Infinity). Uses a binary min-heap so a
 * warehouse graph of thousands of points routes in O(E log V) per call.
 */
export function shortestDistancesFrom(
  graph: RoadGraph,
  source: string,
): Map<string, number> {
  const dist = new Map<string, number>();
  if (!graph.has(source)) return dist;

  const heap = new MinHeap();
  dist.set(source, 0);
  heap.push(source, 0);

  while (heap.size > 0) {
    const { node, priority } = heap.pop();
    const isStale = priority > (dist.get(node) ?? Infinity);
    if (isStale) continue;
    for (const edge of graph.get(node) ?? []) {
      const next = priority + edge.length;
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        heap.push(edge.to, next);
      }
    }
  }
  return dist;
}

class MinHeap {
  private readonly items: Array<{ node: string; priority: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(node: string, priority: number): void {
    const items = this.items;
    items.push({ node, priority });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].priority <= items[i].priority) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): { node: string; priority: number } {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (
          left < items.length &&
          items[left].priority < items[smallest].priority
        )
          smallest = left;
        if (
          right < items.length &&
          items[right].priority < items[smallest].priority
        )
          smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}
