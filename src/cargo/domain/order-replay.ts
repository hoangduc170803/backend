import type { TaskLeg } from './events';

const CARGO_LEGS: ReadonlySet<string> = new Set([
  'PICKUP',
  'APPROACH',
  'DROPOFF',
]);

export function cargoLegOf(leg: string): TaskLeg | null {
  return CARGO_LEGS.has(leg) ? (leg as TaskLeg) : null;
}
