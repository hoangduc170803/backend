import type { TaskOrderOutcome } from './events';

export const RECREATED_OUTCOMES: ReadonlySet<TaskOrderOutcome> = new Set([
  'FAILED',
  'WITHDRAWN_EXTERNALLY',
  'LOST',
]);

export const MAX_ORDER_RECREATIONS = 3;
export const ORDER_RECREATION_WINDOW_MS = 10 * 60_000;

export interface OrderRecreationBudget {
  count: number;
  windowStartedAt: string;
  lastOrderName: string;
}

export type RecreationDecision =
  | { allowed: true; next: OrderRecreationBudget }
  | { allowed: false; spent: number };

export function spendRecreation(
  budget: OrderRecreationBudget | undefined,
  orderName: string,
  now: Date,
): RecreationDecision {
  const windowOpen =
    budget !== undefined &&
    now.getTime() - new Date(budget.windowStartedAt).getTime() <
      ORDER_RECREATION_WINDOW_MS;
  const spent = windowOpen ? budget.count : 0;
  if (spent >= MAX_ORDER_RECREATIONS) return { allowed: false, spent };
  return {
    allowed: true,
    next: {
      count: spent + 1,
      windowStartedAt: windowOpen ? budget.windowStartedAt : now.toISOString(),
      lastOrderName: orderName,
    },
  };
}

export function recreationsInWindow(
  budget: OrderRecreationBudget | undefined,
  now: Date,
): number {
  if (!budget) return 0;
  const age = now.getTime() - new Date(budget.windowStartedAt).getTime();
  return age < ORDER_RECREATION_WINDOW_MS ? budget.count : 0;
}

export function recreationNotice(
  budget: OrderRecreationBudget | undefined,
  now: Date,
): string | null {
  const count = recreationsInWindow(budget, now);
  return count > 0
    ? `Hệ thống điều khiển đã huỷ lệnh — WES đã tự tạo lại ${count}/${MAX_ORDER_RECREATIONS} lần`
    : null;
}

export function exhaustedReason(orderName: string): string {
  return `Hệ thống điều khiển đã huỷ lệnh ${MAX_ORDER_RECREATIONS} lần trong ${ORDER_RECREATION_WINDOW_MS / 60_000} phút — WES dừng tự tạo lại lệnh (lệnh cuối: ${orderName}).`;
}
