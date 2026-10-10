export const MIN_BODY_SEPARATION_MM = 840;
export const RETREAT_NODES = 2;

export type QueueRequest = 'reserve' | 'commit';

export interface QueueNode {
  readonly pointName: string;
  readonly locationName: string | null;
  readonly along: number;
}

export interface ColumnClaims {
  readonly finished: ReadonlySet<string>;
  readonly committed: ReadonlySet<string>;
  readonly reserved: ReadonlySet<string>;
}

export const NOTHING_CLAIMED: ColumnClaims = {
  finished: new Set(),
  committed: new Set(),
  reserved: new Set(),
};

interface Occupant {
  readonly index: number;
  readonly isTop: boolean;
}

export function targetOf(node: QueueNode): string {
  return node.locationName ?? node.pointName;
}

export class ColumnQueue {
  private constructor(
    private readonly nodes: readonly QueueNode[],
    private readonly claims: ColumnClaims,
  ) {}

  static of(
    nodes: readonly QueueNode[],
    claims: ColumnClaims = NOTHING_CLAIMED,
  ): ColumnQueue {
    return new ColumnQueue(nodes, claims);
  }

  top(): QueueNode | null {
    const index = this.topIndex();
    return index === -1 ? null : this.nodes[index];
  }

  next(request: QueueRequest): QueueNode | null {
    if (request === 'commit') return this.deepestCellStillReachable();
    return this.standingRoom().find((node) => !this.isHeld(node)) ?? null;
  }

  private deepestCellStillReachable(): QueueNode | null {
    let behindTheLastBody = 0;
    for (const [index, node] of this.nodes.entries()) {
      if (this.isFinished(node) || this.claims.committed.has(targetOf(node))) {
        behindTheLastBody = index + 1;
      }
    }
    const cell = this.nodes[behindTheLastBody];
    return cell?.locationName != null ? cell : null;
  }

  standing(): QueueNode[] {
    return this.standingRoom();
  }

  capacity(): number {
    return this.standingRoom().length;
  }

  get reservedCount(): number {
    return this.countClaimed(this.claims.reserved);
  }

  get committedCount(): number {
    return this.countClaimed(this.claims.committed);
  }

  describe(): string {
    const top = this.top();
    const holding = this.standingRoom()
      .filter((node) => this.isHeld(node))
      .map(targetOf);
    return [
      `${this.reservedCount} reserved + ${this.committedCount} committed of ${this.capacity()}`,
      top ? `top ${targetOf(top)}` : 'every cell already finished',
      holding.length > 0 ? `holding ${holding.join(', ')}` : 'nothing holding',
    ].join(', ');
  }

  private standingRoom(): QueueNode[] {
    const topIndex = this.topIndex();
    if (topIndex === -1 || !this.hasASlotLeftToDropOn()) return [];

    const room: QueueNode[] = [];
    let last: Occupant | null = null;
    for (let index = topIndex; index < this.nodes.length; index++) {
      if (this.isFinished(this.nodes[index])) continue;
      if (last !== null && !this.clearsOf(last, index)) continue;
      room.push(this.nodes[index]);
      last = { index, isTop: index === topIndex };
    }
    return room;
  }

  private clearsOf(last: Occupant, index: number): boolean {
    const settled = last.isTop
      ? Math.min(last.index + RETREAT_NODES, this.nodes.length - 1)
      : last.index;
    if (index <= settled) return false;
    return (
      Math.abs(this.nodes[index].along - this.nodes[settled].along) >=
      MIN_BODY_SEPARATION_MM
    );
  }

  private hasASlotLeftToDropOn(): boolean {
    return this.nodes.some(
      (node) => node.locationName !== null && !this.isFinished(node),
    );
  }

  private topIndex(): number {
    let behindTheLastPallet = 0;
    let deepestBody = -1;
    for (const [index, node] of this.nodes.entries()) {
      if (this.isFinished(node)) behindTheLastPallet = index + 1;
      if (this.claims.committed.has(targetOf(node))) deepestBody = index;
    }
    const anchor = Math.max(behindTheLastPallet, deepestBody);
    return anchor < this.nodes.length ? anchor : -1;
  }

  private isFinished(node: QueueNode): boolean {
    return this.claims.finished.has(targetOf(node));
  }

  private isHeld(node: QueueNode): boolean {
    const target = targetOf(node);
    return (
      this.claims.reserved.has(target) || this.claims.committed.has(target)
    );
  }

  private countClaimed(claimed: ReadonlySet<string>): number {
    return this.nodes.filter((node) => claimed.has(targetOf(node))).length;
  }
}
