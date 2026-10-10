export const KPI_WINDOWS = ['today', '24h', '7d'] as const;

export type KpiWindow = (typeof KPI_WINDOWS)[number];

export type BucketUnit = 'hour' | 'day';

export const DEFAULT_KPI_WINDOW: KpiWindow = 'today';

export function bucketUnitFor(window: KpiWindow): BucketUnit {
  return window === '7d' ? 'day' : 'hour';
}

export function isKpiWindow(value: unknown): value is KpiWindow {
  return KPI_WINDOWS.includes(value as KpiWindow);
}

export interface TerminalCounts {
  completed: number;
  failed: number;
  cancelled: number;
}

export function terminalTotal(counts: TerminalCounts): number {
  return counts.completed + counts.failed + counts.cancelled;
}

export function failureRate(counts: TerminalCounts): number | null {
  const total = terminalTotal(counts);
  if (total === 0) return null;
  return roundTo((counts.failed + counts.cancelled) / total, 4);
}

export function successRate(counts: TerminalCounts): number | null {
  const rate = failureRate(counts);
  return rate === null ? null : roundTo(1 - rate, 4);
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function roundSeconds(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
