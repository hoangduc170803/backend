export class LatestWins {
  private readonly latest = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private counter = 0;

  begin(key: string): number {
    const token = ++this.counter;
    this.latest.set(key, token);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    return token;
  }

  settle(key: string, token: number): boolean {
    const isLatest = this.latest.get(key) === token;
    const remaining = (this.pending.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.pending.set(key, remaining);
    } else {
      this.pending.delete(key);
      this.latest.delete(key);
    }
    return isLatest;
  }

  get trackedKeys(): number {
    return this.latest.size;
  }
}
