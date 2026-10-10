import type { TransportOrderDto } from '../dto/operating.dto';

export const TERMINAL_ORDER_STATES: ReadonlySet<string> = new Set([
  'FINISHED',
  'FAILED',
  'UNROUTABLE',
]);

export const PROCESSING_ORDER_STATE = 'BEING_PROCESSED';

export interface OrderRetentionLimits {
  maxRecentTerminal: number;
  recentTerminalTtlMs: number;
}

export type OrderRetentionOp =
  | { op: 'upsert'; order: TransportOrderDto }
  | { op: 'remove'; name: string };

interface TerminalEntry {
  order: TransportOrderDto;
  terminalAt: number;
}

export function isTerminalOrder(
  order: Pick<TransportOrderDto, 'state'>,
): boolean {
  return TERMINAL_ORDER_STATES.has(order.state);
}

function sameOrder(a: TransportOrderDto, b: TransportOrderDto): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function instantOf(iso: string | null): number | null {
  const instant = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(instant) ? null : instant;
}

function endedAt(order: TransportOrderDto, fallback: number): number {
  return (
    instantOf(order.finishedTime) ?? instantOf(order.creationTime) ?? fallback
  );
}

export class OrderRetention {
  private readonly active = new Map<string, TransportOrderDto>();
  private readonly terminal = new Map<string, TerminalEntry>();

  constructor(private readonly limits: OrderRetentionLimits) {}

  apply(order: TransportOrderDto, now: number): OrderRetentionOp[] {
    if (!isTerminalOrder(order)) {
      const previous = this.active.get(order.name);
      this.terminal.delete(order.name);
      this.active.set(order.name, order);
      return previous && sameOrder(previous, order)
        ? []
        : [{ op: 'upsert', order }];
    }

    this.active.delete(order.name);
    const previous = this.terminal.get(order.name);
    if (previous && sameOrder(previous.order, order)) return [];
    this.terminal.delete(order.name);
    this.terminal.set(order.name, {
      order,
      terminalAt: previous?.terminalAt ?? now,
    });
    return [{ op: 'upsert', order }, ...this.evict(now)];
  }

  remove(name: string): OrderRetentionOp[] {
    const wasActive = this.active.delete(name);
    const wasTerminal = this.terminal.delete(name);
    return wasActive || wasTerminal ? [{ op: 'remove', name }] : [];
  }

  sweep(now: number): OrderRetentionOp[] {
    return this.evict(now);
  }

  reconcile(
    orders: readonly TransportOrderDto[],
    now: number,
  ): OrderRetentionOp[] {
    const present = new Set(orders.map((order) => order.name));
    const ops: OrderRetentionOp[] = [];
    for (const name of [...this.active.keys()]) {
      if (!present.has(name)) ops.push(...this.remove(name));
    }
    for (const order of orders) {
      if (!isTerminalOrder(order)) ops.push(...this.apply(order, now));
    }
    const terminalOrders = orders.filter(isTerminalOrder);
    for (const order of terminalOrders) {
      if (this.active.has(order.name)) ops.push(...this.apply(order, now));
    }
    const unseenNewestLast = terminalOrders
      .filter((order) => !this.terminal.has(order.name))
      .sort((a, b) => endedAt(a, now) - endedAt(b, now))
      .slice(-this.limits.maxRecentTerminal);
    for (const order of unseenNewestLast) {
      const terminalAt = endedAt(order, now);
      if (now - terminalAt > this.limits.recentTerminalTtlMs) continue;
      this.terminal.set(order.name, { order, terminalAt });
      ops.push({ op: 'upsert', order });
    }
    return [...ops, ...this.evict(now)];
  }

  clear(): void {
    this.active.clear();
    this.terminal.clear();
  }

  list(): TransportOrderDto[] {
    return [
      ...this.active.values(),
      ...[...this.terminal.values()].map((entry) => entry.order),
    ];
  }

  counts(): { active: number; processing: number; recentTerminal: number } {
    let processing = 0;
    for (const order of this.active.values()) {
      if (order.state === PROCESSING_ORDER_STATE) processing += 1;
    }
    return {
      active: this.active.size,
      processing,
      recentTerminal: this.terminal.size,
    };
  }

  private evict(now: number): OrderRetentionOp[] {
    const ops: OrderRetentionOp[] = [];
    const oldestFirst = [...this.terminal.entries()].sort(
      ([, a], [, b]) => a.terminalAt - b.terminalAt,
    );
    let size = this.terminal.size;
    for (const [name, entry] of oldestFirst) {
      const expired = now - entry.terminalAt > this.limits.recentTerminalTtlMs;
      const overflow = size > this.limits.maxRecentTerminal;
      if (!expired && !overflow) break;
      this.terminal.delete(name);
      size -= 1;
      ops.push({ op: 'remove', name });
    }
    return ops;
  }
}
