import {
  KernelSessionPhase,
  WAIT_KERNEL_OPERATING,
  WAIT_PLANT_MODEL_WRITE,
  decideSession,
  type SessionMemory,
} from './kernel-session';
import {
  EPOCH_PROPERTY,
  epochEntityBody,
  epochEntityName,
  liveEpochNames,
  liveEpochOf,
} from './kernel-epoch';

const memory = (overrides: Partial<SessionMemory> = {}): SessionMemory => ({
  phase: KernelSessionPhase.READY,
  epoch: 'e1',
  writesInFlight: 0,
  pendingReason: null,
  ...overrides,
});

const up = { reachable: true, operating: true, epoch: 'e1' };

describe('decideSession', () => {
  it('is offline while the kernel cannot be reached', () => {
    expect(
      decideSession(
        { reachable: false, operating: false, epoch: null },
        memory(),
      ),
    ).toEqual({ kind: 'OFFLINE' });
  });

  it('waits while the kernel is not operating yet', () => {
    expect(
      decideSession(
        { reachable: true, operating: false, epoch: null },
        memory(),
      ),
    ).toEqual({ kind: 'WAIT', step: WAIT_KERNEL_OPERATING });
  });

  it('never restores while WES is still writing the plant model', () => {
    expect(
      decideSession(
        { reachable: true, operating: true, epoch: null },
        memory({ writesInFlight: 1, pendingReason: 'zone edit' }),
      ),
    ).toEqual({ kind: 'WAIT', step: WAIT_PLANT_MODEL_WRITE });
  });

  it('is ready when the kernel still carries an epoch and nothing is pending', () => {
    expect(decideSession(up, memory())).toEqual({ kind: 'READY', epoch: 'e1' });
  });

  it('restores after a plant model write even if the epoch survived', () => {
    expect(
      decideSession(up, memory({ pendingReason: 'Ghi bản đồ: zone edit' })),
    ).toEqual({ kind: 'RESTORE', reason: 'Ghi bản đồ: zone edit' });
  });

  it('restores when the epoch is gone, naming a restart after being offline', () => {
    const lost = { reachable: true, operating: true, epoch: null };
    expect(
      decideSession(lost, memory({ phase: KernelSessionPhase.OFFLINE })),
    ).toEqual({ kind: 'RESTORE', reason: 'Kernel vừa khởi động lại' });
    expect(decideSession(lost, memory()).kind).toBe('RESTORE');
  });
});

describe('kernel epoch marker', () => {
  it('is an ignored, closed, far-away OBJECT carrying the epoch', () => {
    const body = epochEntityBody('abc');
    expect(epochEntityName('abc')).toBe('WES-KERNEL-EPOCH-abc');
    expect(body).toMatchObject({
      type: 'OBJECT',
      integrationLevel: 'TO_BE_IGNORED',
      incompleteName: false,
      properties: { [EPOCH_PROPERTY]: 'abc' },
    });
    const vertices = (body.envelope as { vertices: unknown[] }).vertices;
    expect(vertices).toHaveLength(5);
    expect(vertices[0]).toEqual(vertices[4]);
  });

  it('reads only a live marker', () => {
    const live = {
      name: 'WES-KERNEL-EPOCH-new',
      retired: false,
      properties: { [EPOCH_PROPERTY]: 'new' },
    };
    const retired = {
      name: 'WES-KERNEL-EPOCH-old',
      retired: true,
      properties: { [EPOCH_PROPERTY]: 'old' },
    };
    const cargo = { name: 'WES-CARGO-x-g1', retired: false, properties: {} };
    expect(liveEpochOf([retired, cargo, live])).toBe('new');
    expect(liveEpochOf([retired, cargo])).toBeNull();
    expect(liveEpochNames([retired, cargo, live])).toEqual([
      'WES-KERNEL-EPOCH-new',
    ]);
  });
});
