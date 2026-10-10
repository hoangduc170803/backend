export const STOP_CHARGING_ACTION = 'stopCharging';
export const CHARGE_SLOT_RESERVATION_TIMEOUT_MS = 120_000;
export const WORK_RECALL_WINDOW_MS = 60_000;
export const TERMINAL_ORDER_STATES: ReadonlySet<string> = new Set([
  'FINISHED',
  'FAILED',
  'UNROUTABLE',
  'WITHDRAWN',
]);
