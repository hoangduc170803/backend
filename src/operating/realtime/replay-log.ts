export interface ReplayEntry {
  seq: number;
  data: string;
}

export interface ReplayLimits {
  maxEntries: number;
  maxBytes: number;
}

const COMPACT_AFTER_DROPPED = 1024;

export class ReplayLog {
  private entries: ReplayEntry[] = [];
  private head = 0;
  private bytes = 0;

  constructor(private readonly limits: ReplayLimits) {}

  append(entry: ReplayEntry): void {
    this.entries.push(entry);
    this.bytes += entry.data.length;
    while (
      this.size > this.limits.maxEntries ||
      (this.bytes > this.limits.maxBytes && this.size > 1)
    ) {
      this.bytes -= this.entries[this.head].data.length;
      this.head += 1;
    }
    if (
      this.head > COMPACT_AFTER_DROPPED &&
      this.head * 2 > this.entries.length
    ) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }

  since(seq: number, latestSeq: number): ReplayEntry[] | null {
    if (seq > latestSeq) return null;
    if (seq === latestSeq) return [];
    const oldest = this.entries[this.head];
    if (!oldest || oldest.seq > seq + 1) return null;
    return this.entries.slice(this.head + (seq + 1 - oldest.seq));
  }

  clear(): void {
    this.entries = [];
    this.head = 0;
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.length - this.head;
  }

  get retainedBytes(): number {
    return this.bytes;
  }
}
