import { NotFoundException } from '@nestjs/common';
import { DispatchPolicyService } from './dispatch-policy.service';
import { DispatchPolicyEntity } from './entities/dispatch-policy.entity';

const policyRow = (
  overrides: Partial<DispatchPolicyEntity> = {},
): DispatchPolicyEntity => ({
  id: 'p1',
  name: 'default',
  weightBattery: 0,
  maxAgvPerBlock: 1,
  isActive: true,
  createdBy: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

function build(findOneResult: DispatchPolicyEntity | null) {
  const manager = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const repo = {
    findOne: jest.fn().mockResolvedValue(findOneResult),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((v: Partial<DispatchPolicyEntity>) => v),
    save: jest
      .fn()
      .mockImplementation((v: Partial<DispatchPolicyEntity>) =>
        Promise.resolve(policyRow(v)),
      ),
    manager: {
      transaction: jest.fn(
        (fn: (m: typeof manager) => Promise<void>): Promise<void> =>
          fn(manager),
      ),
    },
  };
  return { repo, manager, service: new DispatchPolicyService(repo as never) };
}

describe('DispatchPolicyService', () => {
  describe('getActiveWeights', () => {
    it('returns null when no policy is active (pure-distance fast path)', async () => {
      const { service } = build(null);
      expect(await service.getActiveWeights()).toBeNull();
    });

    it('returns the active weights', async () => {
      const { service } = build(policyRow({ weightBattery: 3 }));
      expect(await service.getActiveWeights()).toEqual({ battery: 3 });
    });

    it('clamps out-of-range weights into [0, 10]', async () => {
      const { service } = build(policyRow({ weightBattery: 5000 }));
      expect(await service.getActiveWeights()).toEqual({ battery: 10 });

      const { service: negative } = build(policyRow({ weightBattery: -4 }));
      expect(await negative.getActiveWeights()).toEqual({ battery: 0 });
    });
  });

  describe('activate', () => {
    it('deactivates every policy then activates the target in one transaction', async () => {
      const { service, repo, manager } = build(policyRow({ isActive: false }));

      await service.activate('p1');

      expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenNthCalledWith(
        1,
        DispatchPolicyEntity,
        { isActive: true },
        { isActive: false },
      );
      expect(manager.update).toHaveBeenNthCalledWith(
        2,
        DispatchPolicyEntity,
        { id: 'p1' },
        { isActive: true },
      );
    });

    it('throws NotFoundException for an unknown id', async () => {
      const { service } = build(null);
      await expect(service.activate('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
