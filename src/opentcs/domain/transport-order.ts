import { createHash } from 'node:crypto';
import type { TransportOrderDestination } from './kernel-model';

export const ORDER_KIND = {
  PICKUP: 'PICKUP',
  APPROACH: 'APPROACH',
  DROPOFF: 'DROPOFF',
  PARK: 'PARK',
  CHARGE: 'CHARGE',
  MANUAL: 'MANUAL',
  MOVE: 'MOVE',
} as const;

export const ANY_VEHICLE = 'ANY';

export type OrderKind = (typeof ORDER_KIND)[keyof typeof ORDER_KIND];

export const ORDER_PROP = {
  TASK_ID: 'wes:taskId',
  LEG: 'wes:leg',
} as const;

export interface IssueTransportOrder {
  readonly kind: OrderKind;
  readonly vehicleName: string | null;
  readonly aimedAt: string;
  readonly destinations: readonly TransportOrderDestination[];
  readonly taskId?: string;
  readonly dispensable?: boolean;
  readonly type?: string;
  /**
   * Makes the order name deterministic instead of random, so a retry of the exact same call
   * (same kind/vehicle/destination/key) reaches the exact same kernel object instead of creating
   * a duplicate. Only safe for a leg that's issued at most once per key — pass something stable
   * per attempt, e.g. the task id for a leg that's never re-aimed/reissued to a new destination.
   */
  readonly idempotencyKey?: string;
}

export interface CancelTransportOrder {
  readonly immediate?: boolean;
  readonly reason?: string;
  readonly replacedBy?: string;
}

const UUID_SUFFIX_LENGTH = 37;

/**
 * A stable, name-based UUID (RFC 4122 §4.3 style — version/variant bits set, the rest is a
 * SHA-1 hash of the inputs) so the same inputs always produce the same 36-character UUID
 * string. Callers pass this instead of a random one when a retry of the exact same attempt must
 * land on the exact same order name — `destinationFromOrderName` below relies on the trailing
 * segment being exactly UUID-shaped, so this must stay 36 characters regardless.
 */
export function deterministicOrderUuid(...parts: string[]): string {
  const hash = createHash('sha1').update(parts.join(':')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function orderNamePrefix(kind: OrderKind): string {
  return `${kind}-`;
}

export function buildOrderName(
  kind: OrderKind,
  vehicleName: string | null,
  aimedAt: string,
  uuid: string,
): string {
  return `${orderNamePrefix(kind)}${vehicleName ?? ANY_VEHICLE}-${aimedAt}-${uuid}`;
}

export function orderProperties(
  kind: OrderKind,
  taskId?: string,
): Record<string, string> {
  const properties: Record<string, string> = { [ORDER_PROP.LEG]: kind };
  if (taskId) properties[ORDER_PROP.TASK_ID] = taskId;
  return properties;
}

export function destinationFromOrderName(
  kind: OrderKind,
  orderName: string | null | undefined,
  vehicleName: string,
): string | null {
  if (!orderName) return null;
  const prefix = `${orderNamePrefix(kind)}${vehicleName}-`;
  if (!orderName.startsWith(prefix)) return null;
  const aimedAt = orderName.slice(
    prefix.length,
    orderName.length - UUID_SUFFIX_LENGTH,
  );
  return aimedAt.length > 0 ? aimedAt : null;
}

export function parkPointFromOrderName(
  orderName: string | null | undefined,
  vehicleName: string,
): string | null {
  return destinationFromOrderName(ORDER_KIND.PARK, orderName, vehicleName);
}
