import { createHash } from 'node:crypto';

/** Identity of the routing graph. Runtime path locks, vehicle state and WES-created
 * locations are intentionally excluded: those change while operating the same map. */
export function topologyFingerprint(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const model = raw as Record<string, unknown>;
  if (!Array.isArray(model.points) || !Array.isArray(model.paths)) return null;
  const sorted = (items: unknown[]) =>
    items.map((item) => JSON.stringify(item)).sort();
  type Point = {
    name: string;
    type: string;
    position?: { x?: number; y?: number; z?: number };
  };
  type Path = {
    name: string;
    srcPointName: string;
    destPointName: string;
    length: number;
    maxVelocity: number;
    maxReverseVelocity: number;
  };
  if (
    ![...(model.points as unknown[]), ...(model.paths as unknown[])].every(
      (item) =>
        item &&
        typeof item === 'object' &&
        'name' in item &&
        typeof item.name === 'string',
    )
  )
    return null;
  const points = (model.points as Point[]).map((p) => [
    p.name,
    p.type,
    p.position?.x ?? 0,
    p.position?.y ?? 0,
    p.position?.z ?? 0,
  ]);
  const paths = (model.paths as Path[]).map((p) => [
    p.name,
    p.srcPointName,
    p.destPointName,
    p.length,
    p.maxVelocity,
    p.maxReverseVelocity,
  ]);
  return createHash('sha256')
    .update(JSON.stringify([model.name, sorted(points), sorted(paths)]))
    .digest('hex');
}
