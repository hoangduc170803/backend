import type { SnapshotItem } from './projection-event';

export type ListChange<T> =
  | { op: 'upsert'; id: string; rev: number; payload: T }
  | { op: 'remove'; id: string; rev: number };

interface PublishedItem<T> {
  rev: number;
  json: string;
  payload: T;
}

export class ListProjection<T> {
  private items = new Map<string, PublishedItem<T>>();

  constructor(private readonly idOf: (item: T) => string) {}

  get size(): number {
    return this.items.size;
  }

  apply(next: readonly T[]): ListChange<T>[] {
    const changes: ListChange<T>[] = [];
    const reordered = new Map<string, PublishedItem<T>>();
    for (const payload of next) {
      const id = this.idOf(payload);
      const json = JSON.stringify(payload);
      const known = this.items.get(id);
      if (known && known.json === json) {
        reordered.set(id, known);
        continue;
      }
      const rev = (known?.rev ?? 0) + 1;
      reordered.set(id, { rev, json, payload });
      changes.push({ op: 'upsert', id, rev, payload });
    }
    for (const [id, known] of this.items) {
      if (!reordered.has(id)) {
        changes.push({ op: 'remove', id, rev: known.rev + 1 });
      }
    }
    this.items = reordered;
    return changes;
  }

  snapshot(): SnapshotItem<T>[] {
    return [...this.items].map(([id, { rev, payload }]) => ({
      id,
      rev,
      payload,
    }));
  }

  clear(): void {
    this.items = new Map();
  }
}
