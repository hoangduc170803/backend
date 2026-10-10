import { isAxiosError } from 'axios';
import { EntitySyncErrorKind } from '../entities/cargo-environmental-entity.entity';

export const ENTITY_NAME_PREFIX = 'WES-CARGO-';
export const CARGO_ID_PROPERTY = 'wes:cargoId';

export function entityNameFor(cargoId: string, generation: number): string {
  return `${ENTITY_NAME_PREFIX}${cargoId}-g${generation}`;
}

export interface KernelEnvironmentalEntity {
  name: string;
  retired: boolean;
  type?: string;
  integrationLevel?: string;
  properties: Record<string, string>;
  envelope?: unknown;
  pose?: unknown;
}

export function toKernelEntity(raw: unknown): KernelEnvironmentalEntity | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name === '') return null;
  return {
    name: record.name,
    retired: record.retired === true,
    type: typeof record.type === 'string' ? record.type : undefined,
    integrationLevel:
      typeof record.integrationLevel === 'string'
        ? record.integrationLevel
        : undefined,
    properties: stringMap(record.properties),
    envelope: record.envelope,
    pose: record.pose,
  };
}

function stringMap(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    return raw.reduce<Record<string, string>>((map, entry: unknown) => {
      const { name, value } = (entry ?? {}) as {
        name?: unknown;
        value?: unknown;
      };
      if (typeof name === 'string' && typeof value === 'string')
        map[name] = value;
      return map;
    }, {});
  }
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function isWesOwned(entity: KernelEnvironmentalEntity): boolean {
  return (
    entity.name.startsWith(ENTITY_NAME_PREFIX) &&
    typeof entity.properties[CARGO_ID_PROPERTY] === 'string'
  );
}

export type EntityMatch =
  | 'MISSING'
  | 'ACTIVE_OWNED'
  | 'RETIRED_OWNED'
  | 'FOREIGN';

export function matchEntity(
  entity: KernelEnvironmentalEntity | null,
  cargoId: string,
): EntityMatch {
  if (!entity) return 'MISSING';
  if (entity.properties[CARGO_ID_PROPERTY] !== cargoId) return 'FOREIGN';
  return entity.retired ? 'RETIRED_OWNED' : 'ACTIVE_OWNED';
}

export function isCreateAck(
  entity: KernelEnvironmentalEntity | null,
  name: string,
  cargoId: string,
): boolean {
  return (
    !!entity &&
    entity.name === name &&
    !entity.retired &&
    entity.properties[CARGO_ID_PROPERTY] === cargoId &&
    (entity.type === undefined || entity.type === 'OBJECT') &&
    (entity.integrationLevel === undefined ||
      entity.integrationLevel === 'TO_BE_RESPECTED')
  );
}

export class EntitySyncError extends Error {
  constructor(
    message: string,
    readonly kind: EntitySyncErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'EntitySyncError';
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_NETWORK',
  'ERR_BAD_RESPONSE',
]);

export function classifyKernelError(err: unknown): EntitySyncError {
  if (err instanceof EntitySyncError) return err;
  if (isAxiosError(err)) {
    const status = err.response?.status ?? null;
    const detail = describeKernelBody(err.response?.data) ?? err.message;
    if (status === null) {
      return new EntitySyncError(
        `Không kết nối được FMS (${err.code ?? 'no response'}): ${err.message}`,
        EntitySyncErrorKind.RETRYABLE,
      );
    }
    if (status >= 500 || TRANSIENT_CODES.has(err.code ?? '')) {
      return new EntitySyncError(
        `FMS lỗi tạm thời HTTP ${status}: ${detail}`,
        EntitySyncErrorKind.RETRYABLE,
        status,
      );
    }
    return new EntitySyncError(
      `FMS từ chối yêu cầu HTTP ${status}: ${detail}`,
      EntitySyncErrorKind.FATAL,
      status,
    );
  }
  return new EntitySyncError(
    (err as Error)?.message ?? String(err),
    EntitySyncErrorKind.RETRYABLE,
  );
}

export function httpStatusOf(err: unknown): number | null {
  return isAxiosError(err) ? (err.response?.status ?? null) : null;
}

function describeKernelBody(data: unknown): string | null {
  if (data == null || data === '') return null;
  if (typeof data === 'string') return data.slice(0, 500);
  if (Array.isArray(data)) return data.map(String).join('; ').slice(0, 500);
  return JSON.stringify(data).slice(0, 500);
}

export interface EntitySyncConfig {
  tickMs: number;
  driftCheckMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
}

export function entitySyncConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EntitySyncConfig {
  return {
    tickMs: positiveInt(env.ENTITY_SYNC_TICK_MS, 2_000),
    driftCheckMs: positiveInt(env.ENTITY_SYNC_DRIFT_CHECK_MS, 15_000),
    baseBackoffMs: positiveInt(env.ENTITY_SYNC_BASE_BACKOFF_MS, 2_000),
    maxBackoffMs: positiveInt(env.ENTITY_SYNC_MAX_BACKOFF_MS, 60_000),
    maxAttempts: positiveInt(env.ENTITY_SYNC_MAX_ATTEMPTS, 10),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function backoffMs(attempt: number, config: EntitySyncConfig): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    config.maxBackoffMs,
    config.baseBackoffMs * 2 ** Math.min(exponent, 30),
  );
}
