import { PermissionsService } from './permissions.service';
import { IMPLICIT_VIEW_PERMISSIONS } from './permission.catalogue';

describe('PermissionsService', () => {
  let roles: { findOne: jest.Mock };
  let rolePermissions: { find: jest.Mock };
  let roleMapScopes: { find: jest.Mock };
  let apiTokens: { findOne: jest.Mock; update: jest.Mock; count: jest.Mock };
  let users: {
    authStateOf: jest.Mock;
    findByIdOrFail: jest.Mock;
    feRoleOf: jest.Mock;
  };
  let service: PermissionsService;

  beforeEach(() => {
    roles = {
      findOne: jest.fn().mockResolvedValue({ id: 1, key: 'operator' }),
    };
    rolePermissions = {
      find: jest.fn().mockResolvedValue([{ permissionKey: 'order.create' }]),
    };
    roleMapScopes = { find: jest.fn().mockResolvedValue([]) };
    apiTokens = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      count: jest.fn(),
    };
    users = {
      authStateOf: jest.fn(),
      findByIdOrFail: jest.fn(),
      feRoleOf: jest.fn(),
    };
    service = new PermissionsService(
      roles as never,
      rolePermissions as never,
      roleMapScopes as never,
      apiTokens as never,
      users as never,
    );
  });

  describe('getRolePermissions', () => {
    it('resolves implicit view permissions plus the role grants', async () => {
      const perms = await service.getRolePermissions('operator');
      expect(perms).toEqual(
        new Set([...IMPLICIT_VIEW_PERMISSIONS, 'order.create']),
      );
    });

    it('caches per role key — the DB is only queried once for repeated calls', async () => {
      await service.getRolePermissions('operator');
      await service.getRolePermissions('operator');
      expect(roles.findOne).toHaveBeenCalledTimes(1);
      expect(rolePermissions.find).toHaveBeenCalledTimes(1);
    });

    it('refresh() drops the cache so the very next request sees an edited grant set', async () => {
      await service.getRolePermissions('operator');
      rolePermissions.find.mockResolvedValue([
        { permissionKey: 'order.withdraw' },
      ]);

      service.refresh();
      const perms = await service.getRolePermissions('operator');

      expect(roles.findOne).toHaveBeenCalledTimes(2);
      expect(perms.has('order.withdraw')).toBe(true);
      expect(perms.has('order.create')).toBe(false);
    });

    it('falls back to only the implicit permissions for an unknown/null role', async () => {
      roles.findOne.mockResolvedValue(null);
      const perms = await service.getRolePermissions(null);
      expect(perms).toEqual(new Set(IMPLICIT_VIEW_PERMISSIONS));
      expect(rolePermissions.find).not.toHaveBeenCalled();
    });
  });

  describe('getRoleMapScope', () => {
    it('returns undefined (unrestricted) for a role with no scope rows', async () => {
      roleMapScopes.find.mockResolvedValue([]);
      await expect(
        service.getRoleMapScope('operator'),
      ).resolves.toBeUndefined();
    });

    it('returns the assigned map record ids for a scoped role', async () => {
      roleMapScopes.find.mockResolvedValue([
        { roleId: 1, mapRecordId: 'map-a' },
        { roleId: 1, mapRecordId: 'map-b' },
      ]);
      await expect(service.getRoleMapScope('operator')).resolves.toEqual([
        'map-a',
        'map-b',
      ]);
    });

    it('caches per role key — the DB is only queried once for repeated calls', async () => {
      await service.getRoleMapScope('operator');
      await service.getRoleMapScope('operator');
      expect(roleMapScopes.find).toHaveBeenCalledTimes(1);
    });

    it('refresh() drops the cache so the very next request sees an edited scope', async () => {
      await service.getRoleMapScope('operator'); // caches "unrestricted"
      roleMapScopes.find.mockResolvedValue([
        { roleId: 1, mapRecordId: 'map-a' },
      ]);

      service.refresh();
      await expect(service.getRoleMapScope('operator')).resolves.toEqual([
        'map-a',
      ]);
    });

    it('returns undefined for an unknown/null role without querying scopes', async () => {
      roles.findOne.mockResolvedValue(null);
      await expect(service.getRoleMapScope(null)).resolves.toBeUndefined();
      expect(roleMapScopes.find).not.toHaveBeenCalled();
    });
  });

  describe('resolveApiToken (permanent JWT, gated by jti)', () => {
    it('returns null when the jti row is missing or revoked', async () => {
      apiTokens.findOne.mockResolvedValue(null);
      expect(await service.resolveApiToken('missing-jti')).toBeNull();

      apiTokens.findOne.mockResolvedValue({
        id: 'row-1',
        userId: 'user-1',
        revokedAt: new Date(),
        lastUsedAt: null,
      });
      expect(await service.resolveApiToken('revoked-jti')).toBeNull();
    });

    it('resolves the owning userId and bumps last_used_at for a live token', async () => {
      apiTokens.findOne.mockResolvedValue({
        id: 'row-1',
        userId: 'user-1',
        revokedAt: null,
        lastUsedAt: null,
      });
      await expect(service.resolveApiToken('live-jti')).resolves.toBe('user-1');
      expect(apiTokens.update).toHaveBeenCalledWith(
        { id: 'row-1' },
        { lastUsedAt: expect.any(Date) },
      );
    });
  });

  describe('resolveAuthUserForApiKey (opaque pasted token, gated by hash)', () => {
    const row = {
      id: 'row-1',
      userId: 'user-1',
      tokenHash: 'hash',
      revokedAt: null,
      lastUsedAt: null,
    };

    it('returns null when the token hash is unknown or revoked', async () => {
      apiTokens.findOne.mockResolvedValue(null);
      expect(await service.resolveAuthUserForApiKey('raw')).toBeNull();

      apiTokens.findOne.mockResolvedValue({ ...row, revokedAt: new Date() });
      expect(await service.resolveAuthUserForApiKey('raw')).toBeNull();
    });

    it('returns null when the owning account is locked, or inactive and not invited', async () => {
      apiTokens.findOne.mockResolvedValue(row);
      users.authStateOf.mockResolvedValue({
        isLocked: true,
        isActive: true,
        isInvited: false,
      });
      expect(await service.resolveAuthUserForApiKey('raw')).toBeNull();

      users.authStateOf.mockResolvedValue({
        isLocked: false,
        isActive: false,
        isInvited: false,
      });
      expect(await service.resolveAuthUserForApiKey('raw')).toBeNull();
    });

    it('builds an AuthUser with freshly-resolved permissions for a valid token/account', async () => {
      apiTokens.findOne.mockResolvedValue(row);
      users.authStateOf.mockResolvedValue({
        isLocked: false,
        isActive: true,
        isInvited: false,
      });
      users.findByIdOrFail.mockResolvedValue({
        id: 'user-1',
        username: 'quan.tran',
      });
      users.feRoleOf.mockReturnValue('operator');

      const auth = await service.resolveAuthUserForApiKey('raw');

      expect(auth).toMatchObject({
        sub: 'user-1',
        username: 'quan.tran',
        role: 'operator',
        roles: ['operator'],
        mustChangePassword: false,
      });
      expect(auth?.perms).toEqual(
        expect.arrayContaining([...IMPLICIT_VIEW_PERMISSIONS, 'order.create']),
      );
      expect(auth?.mapIds).toBeUndefined();
    });

    it("carries the role's map scope through onto the AuthUser too, when one is assigned", async () => {
      apiTokens.findOne.mockResolvedValue(row);
      users.authStateOf.mockResolvedValue({
        isLocked: false,
        isActive: true,
        isInvited: false,
      });
      users.findByIdOrFail.mockResolvedValue({
        id: 'user-1',
        username: 'quan.tran',
      });
      users.feRoleOf.mockReturnValue('operator');
      roleMapScopes.find.mockResolvedValue([
        { roleId: 1, mapRecordId: 'map-a' },
      ]);

      const auth = await service.resolveAuthUserForApiKey('raw');
      expect(auth?.mapIds).toEqual(['map-a']);
    });
  });

  describe('API token and user token parity', () => {
    it('an API token and a normal user session on the same role resolve identical permission sets', async () => {
      apiTokens.findOne.mockResolvedValue({
        id: 'row-1',
        userId: 'user-1',
        tokenHash: 'hash',
        revokedAt: null,
        lastUsedAt: null,
      });
      users.authStateOf.mockResolvedValue({
        isLocked: false,
        isActive: true,
        isInvited: false,
      });
      users.findByIdOrFail.mockResolvedValue({
        id: 'user-1',
        username: 'quan.tran',
      });
      users.feRoleOf.mockReturnValue('operator');

      const viaApiToken = await service.resolveAuthUserForApiKey('raw');
      const viaSession = await service.getRolePermissions('operator');

      expect(new Set(viaApiToken?.perms)).toEqual(viaSession);
    });

    it('an API token and a normal user session on the same role resolve identical map scope', async () => {
      apiTokens.findOne.mockResolvedValue({
        id: 'row-1',
        userId: 'user-1',
        tokenHash: 'hash',
        revokedAt: null,
        lastUsedAt: null,
      });
      users.authStateOf.mockResolvedValue({
        isLocked: false,
        isActive: true,
        isInvited: false,
      });
      users.findByIdOrFail.mockResolvedValue({
        id: 'user-1',
        username: 'quan.tran',
      });
      users.feRoleOf.mockReturnValue('operator');
      roleMapScopes.find.mockResolvedValue([
        { roleId: 1, mapRecordId: 'map-a' },
      ]);

      const viaApiToken = await service.resolveAuthUserForApiKey('raw');
      const viaSession = await service.getRoleMapScope('operator');

      expect(viaApiToken?.mapIds).toEqual(viaSession);
    });
  });
});
