import { EntitySyncErrorKind } from '../entities/cargo-environmental-entity.entity';
import {
  connectionRefused,
  httpError,
  timeoutError,
} from '../entity-sync.testing';
import {
  EntitySyncError,
  backoffMs,
  classifyKernelError,
  entityNameFor,
  entitySyncConfigFromEnv,
  isCreateAck,
  isWesOwned,
  matchEntity,
  toKernelEntity,
} from './entity-sync.policy';

describe('entityNameFor', () => {
  it('is stable for a cargo and generation', () => {
    expect(entityNameFor('c-1', 1)).toBe('WES-CARGO-c-1-g1');
    expect(entityNameFor('c-1', 1)).toBe(entityNameFor('c-1', 1));
    expect(entityNameFor('c-1', 2)).not.toBe(entityNameFor('c-1', 1));
  });
});

describe('classifyKernelError', () => {
  it.each([
    ['a timeout', timeoutError()],
    ['a refused connection', connectionRefused()],
    ['HTTP 500', httpError(500)],
    ['HTTP 503', httpError(503)],
    ['a non-HTTP failure', new Error('socket hang up')],
  ])('retries %s', (_label, error) => {
    expect(classifyKernelError(error).kind).toBe(EntitySyncErrorKind.RETRYABLE);
  });

  it.each([400, 404, 409, 422])('does not retry HTTP %s blindly', (status) => {
    expect(classifyKernelError(httpError(status)).kind).toBe(
      EntitySyncErrorKind.FATAL,
    );
  });

  it("keeps the kernel's own reason", () => {
    expect(
      classifyKernelError(httpError(400, ['Could not parse JSON input']))
        .message,
    ).toContain('Could not parse JSON input');
  });

  it('passes an already classified error through', () => {
    const error = new EntitySyncError('x', EntitySyncErrorKind.FATAL);
    expect(classifyKernelError(error)).toBe(error);
  });
});

describe('backoffMs', () => {
  const config = entitySyncConfigFromEnv({});

  it('doubles from the base and caps at the maximum', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffMs(n, config))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('is configurable', () => {
    const custom = entitySyncConfigFromEnv({
      ENTITY_SYNC_BASE_BACKOFF_MS: '500',
      ENTITY_SYNC_MAX_BACKOFF_MS: '1500',
      ENTITY_SYNC_MAX_ATTEMPTS: '3',
    });
    expect(custom.maxAttempts).toBe(3);
    expect([1, 2, 3].map((n) => backoffMs(n, custom))).toEqual([
      500, 1_000, 1_500,
    ]);
  });
});

describe('kernel entity matching', () => {
  const entity = (overrides: Record<string, unknown> = {}) =>
    toKernelEntity({
      name: 'WES-CARGO-c-1-g1',
      retired: false,
      type: 'OBJECT',
      integrationLevel: 'TO_BE_RESPECTED',
      properties: { 'wes:cargoId': 'c-1' },
      ...overrides,
    });

  it('tells missing, owned, retired and foreign apart', () => {
    expect(matchEntity(null, 'c-1')).toBe('MISSING');
    expect(matchEntity(entity(), 'c-1')).toBe('ACTIVE_OWNED');
    expect(matchEntity(entity({ retired: true }), 'c-1')).toBe('RETIRED_OWNED');
    expect(matchEntity(entity(), 'c-2')).toBe('FOREIGN');
  });

  it('accepts a CREATE answer only when it is the live, respected entity of the cargo', () => {
    expect(isCreateAck(entity(), 'WES-CARGO-c-1-g1', 'c-1')).toBe(true);
    expect(
      isCreateAck(entity({ retired: true }), 'WES-CARGO-c-1-g1', 'c-1'),
    ).toBe(false);
    expect(
      isCreateAck(
        entity({ integrationLevel: 'TO_BE_IGNORED' }),
        'WES-CARGO-c-1-g1',
        'c-1',
      ),
    ).toBe(false);
    expect(isCreateAck(entity(), 'WES-CARGO-c-1-g2', 'c-1')).toBe(false);
    expect(isCreateAck(toKernelEntity({}), 'WES-CARGO-c-1-g1', 'c-1')).toBe(
      false,
    );
  });

  it('owns only WES-prefixed entities carrying the cargo trace', () => {
    expect(isWesOwned(entity()!)).toBe(true);
    expect(isWesOwned(entity({ properties: {} })!)).toBe(false);
    expect(isWesOwned(entity({ name: 'FORKLIFT-ZONE' })!)).toBe(false);
  });

  it('reads the properties map and the [{name, value}] shape', () => {
    expect(
      toKernelEntity({
        name: 'x',
        properties: [{ name: 'wes:cargoId', value: 'c-1' }],
      })?.properties,
    ).toEqual({ 'wes:cargoId': 'c-1' });
  });
});
