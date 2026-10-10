/**
 * Graph-based detection of single-file corridors in an OpenTCS path graph, used
 * to emit `SINGLE_VEHICLE_ONLY` blocks so the kernel scheduler serialises lane
 * access. With such blocks the multi-AGV deadlock on a one-lane / dead-end
 * passage becomes impossible at the allocation layer: the scheduler refuses to
 * let a second vehicle allocate any resource of a block another vehicle is in.
 *
 * A corridor is a maximal chain of points whose interior nodes each connect to
 * exactly two neighbours (undirected degree 2) - a physically single-file
 * passage. It is bounded at each end by a junction (degree >= 3, a shared
 * intersection) or a dead-end (degree 1). Only DEAD-END corridors are wrapped in
 * a `SINGLE_VEHICLE_ONLY` block: a vehicle parked at the tip blocks the sole way
 * out for anyone behind it, and the tip vehicle must reverse back through the
 * whole lane to leave, so two vehicles inside inevitably trap each other. Left
 * to the base scheduler on purpose:
 *   - through corridors / rings (both ends are junctions) - no dead-end trap;
 *   - bare junction-junction edges and single-point spurs (not lanes).
 * The block covers EVERY point of the lane, including its mouth junction. The
 * mouth must be inside the block: otherwise a vehicle waiting to enter camps on
 * the mouth (the lane's sole exit) and deadlocks the vehicle reversing out. Each
 * dead-end lane has its own distinct mouth and the feeder aisle is a grid, so
 * holding a mouth while the lane is busy only makes other traffic route around
 * it rather than coupling separate lanes.
 *
 * Direction-agnostic by design: a one-way chain is just as single-file as a
 * two-way one, and reverse travel (`maxReverseVelocity > 0`) does not widen it -
 * so the corridor topology is computed on the UNDIRECTED graph. Locked paths are
 * excluded: vehicles cannot route over them, so they are not part of the
 * traversable topology.
 *
 * Pure: no I/O. Feed it the plant model's paths; get back block definitions to
 * drop into `PlantModelDto.blocks` before pushing to the kernel. Pass
 * `reservedPoints` (the points already inside hand-authored blocks) to skip
 * lanes an operator has already blocked, so generation never double-covers them.
 */

/** Minimal path shape the detector needs (matches PathDto and the kernel's
    plant-model JSON path objects). */
export interface CorridorPath {
  name: string;
  srcPointName: string;
  destPointName: string;
  locked?: boolean;
}

export interface SingleVehicleBlock {
  name: string;
  type: 'SINGLE_VEHICLE_ONLY';
  memberNames: string[];
}

/** Separator for the undirected point-pair key. A NUL char cannot appear in an
    OpenTCS object name, so the composite key is collision-free. */
const SEP = String.fromCharCode(0);

/** Order-independent key for the undirected point pair {a, b}. */
function pairKey(a: string, b: string): string {
  return a < b ? a + SEP + b : b + SEP + a;
}

export function detectSingleVehicleBlocks(
  paths: readonly CorridorPath[],
  reservedPoints: ReadonlySet<string> = new Set(),
): SingleVehicleBlock[] {
  // 1. Undirected adjacency + the path name(s) spanning each undirected pair.
  //    A single-file lane with reverse travel has two path objects (fwd + rev)
  //    for one physical edge; both must end up in the block.
  const neighbors = new Map<string, Set<string>>();
  const pairPaths = new Map<string, string[]>();

  const addNeighbor = (a: string, b: string): void => {
    let s = neighbors.get(a);
    if (!s) neighbors.set(a, (s = new Set<string>()));
    s.add(b);
  };

  for (const p of paths) {
    if (p.locked) continue;
    const a = p.srcPointName;
    const b = p.destPointName;
    if (!a || !b || a === b) continue; // ignore malformed / self-loops
    addNeighbor(a, b);
    addNeighbor(b, a);
    const key = pairKey(a, b);
    const list = pairPaths.get(key);
    if (list) list.push(p.name);
    else pairPaths.set(key, [p.name]);
  }

  const degree = (p: string): number => neighbors.get(p)?.size ?? 0;
  const isInterior = (p: string): boolean => degree(p) === 2;

  // 2. Walk maximal corridors from every NON-interior (boundary) node along its
  //    degree-2 neighbours until the next boundary node. Deduped by edge set so
  //    the same corridor found from both ends is kept once.
  const corridors: string[][] = [];
  const seen = new Set<string>();

  const walkFrom = (boundary: string, first: string): string[] => {
    const nodes = [boundary, first];
    let prev = boundary;
    let cur = first;
    while (isInterior(cur)) {
      let next: string | undefined;
      for (const n of neighbors.get(cur)!) {
        if (n !== prev) {
          next = n;
          break;
        }
      }
      if (next === undefined || next === boundary) break;
      prev = cur;
      cur = next;
      nodes.push(cur);
    }
    return nodes;
  };

  const corridorKey = (nodes: string[]): string => {
    const edges: string[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      edges.push(pairKey(nodes[i], nodes[i + 1]));
    }
    return edges.sort().join('|');
  };

  const boundaries = [...neighbors.keys()].filter((p) => !isInterior(p)).sort();
  for (const b of boundaries) {
    for (const first of [...neighbors.get(b)!].sort()) {
      const nodes = walkFrom(b, first);
      if (nodes.length < 3) continue; // needs >=1 interior node to be a corridor
      const key = corridorKey(nodes);
      if (seen.has(key)) continue;
      seen.add(key);
      corridors.push(nodes);
    }
  }

  // 3. Isolated cycles: an all-degree-2 ring has no boundary node, so step 2
  //    never reaches it. Walk any still-uncovered interior node once as a loop.
  const covered = new Set<string>();
  for (const nodes of corridors) for (const n of nodes) covered.add(n);

  for (const start of [...neighbors.keys()].sort()) {
    if (!isInterior(start) || covered.has(start)) continue;
    const nodes = [start];
    covered.add(start);
    let prev = start;
    let cur = [...neighbors.get(start)!].sort()[0];
    while (cur !== start) {
      nodes.push(cur);
      covered.add(cur);
      let next: string | undefined;
      for (const n of neighbors.get(cur)!) {
        if (n !== prev) {
          next = n;
          break;
        }
      }
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    nodes.push(start); // close the ring
    if (nodes.length >= 3) corridors.push(nodes);
  }

  // 4. Build blocks. Members = interior + dead-end points (junctions excluded)
  //    plus every path name spanning consecutive corridor nodes.
  const blocks: SingleVehicleBlock[] = [];
  const usedNames = new Set<string>();

  for (const nodes of corridors) {
    // Serialise ONLY dead-end lanes (one endpoint has degree 1). Through
    // corridors and rings (both ends are junctions) are left to the base
    // scheduler: they have no dead-end trap and blocking them would throttle
    // main aisles.
    const hasDeadEnd =
      degree(nodes[0]) === 1 || degree(nodes[nodes.length - 1]) === 1;
    if (!hasDeadEnd) continue;

    // Skip lanes an operator already blocked by hand: a lane is uniquely
    // identified by its dead-end tip, so if that tip is a member of a reserved
    // (manual) block, this lane is covered. Regenerating it would double-cover
    // the column (manual block + SVB-*). A tip that later loses its manual
    // block simply drops out of `reservedPoints` and gets regenerated.
    const laneDeadEnds = [nodes[0], nodes[nodes.length - 1]].filter(
      (n) => degree(n) === 1,
    );
    if (laneDeadEnds.some((n) => reservedPoints.has(n))) continue;

    // Every corridor point, INCLUDING the mouth junction — a waiting vehicle
    // must not be able to camp on the mouth and trap the vehicle reversing out.
    const members = new Set<string>(nodes);
    for (let i = 0; i + 1 < nodes.length; i++) {
      const names = pairPaths.get(pairKey(nodes[i], nodes[i + 1]));
      if (names) for (const nm of names) members.add(nm);
    }
    if (members.size === 0) continue;

    const ends = [nodes[0], nodes[nodes.length - 1]].sort();
    let name = `SVB-${ends[0]}-${ends[1]}`;
    let suffix = 2;
    while (usedNames.has(name)) name = `SVB-${ends[0]}-${ends[1]}-${suffix++}`;
    usedNames.add(name);

    blocks.push({
      name,
      type: 'SINGLE_VEHICLE_ONLY',
      memberNames: [...members].sort(),
    });
  }

  blocks.sort((a, b) => a.name.localeCompare(b.name));
  return blocks;
}
