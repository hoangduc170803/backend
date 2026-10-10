import { RbacService } from './rbac.service';
import type { PermissionsService } from '../auth/permissions.service';

function makeService() {
  const roles = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const rolePermissions = { find: jest.fn().mockResolvedValue([]) };
  const transaction = jest.fn(
    async (work: (manager: unknown) => Promise<unknown>) =>
      work({
        getRepository: (entity: { name: string }) =>
          entity.name === 'RoleEntity'
            ? { findOneOrFail: jest.fn().mockResolvedValue({ id: 2 }) }
            : roleMapScopes,
      }),
  );
  const roleMapScopes = {
    manager: { transaction },
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const userRoles = {
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    }),
  };
  const mapRecords = { find: jest.fn().mockResolvedValue([]) };
  const permissions = { refresh: jest.fn() };

  const service = new RbacService(
    roles as never,
    rolePermissions as never,
    roleMapScopes as never,
    userRoles as never,
    mapRecords as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    permissions as unknown as PermissionsService,
  );
  return { service, roles, roleMapScopes, mapRecords, permissions };
}

describe('RbacService.setMapScope', () => {
  it('runs replacement inside a transaction and never refreshes permissions after insert failure', async () => {
    const { service, roles, roleMapScopes, mapRecords, permissions } =
      makeService();
    roles.findOne.mockResolvedValue({ id: 2, key: 'operator' });
    mapRecords.find.mockResolvedValue([{ id: 'map-b' }]);
    roleMapScopes.insert.mockRejectedValue(new Error('insert failed'));
    await expect(
      service.setMapScope(2, { mapRecordIds: ['map-b'] }),
    ).rejects.toThrow('insert failed');
    expect(roleMapScopes.manager.transaction).toHaveBeenCalledTimes(1);
    expect(permissions.refresh).not.toHaveBeenCalled();
  });
  it('round-trips a scope assignment: validates the map ids exist, replaces the rows, refreshes the cache', async () => {
    const { service, roles, roleMapScopes, mapRecords, permissions } =
      makeService();
    roles.findOne.mockResolvedValue({
      id: 2,
      key: 'operator',
      name: 'Operator',
    });
    mapRecords.find.mockResolvedValue([{ id: 'map-a' }, { id: 'map-b' }]);
    roles.find.mockResolvedValue([
      {
        id: 2,
        key: 'operator',
        name: 'Operator',
        description: null,
        isSystem: false,
      },
    ]);
    roleMapScopes.find.mockResolvedValue([
      { roleId: 2, mapRecordId: 'map-a' },
      { roleId: 2, mapRecordId: 'map-b' },
    ]);

    const result = await service.setMapScope(2, {
      mapRecordIds: ['map-a', 'map-b'],
    });

    expect(roleMapScopes.delete).toHaveBeenCalledWith({ roleId: 2 });
    expect(roleMapScopes.insert).toHaveBeenCalledWith([
      { roleId: 2, mapRecordId: 'map-a' },
      { roleId: 2, mapRecordId: 'map-b' },
    ]);
    expect(permissions.refresh).toHaveBeenCalledTimes(1);
    expect(result.mapScope).toEqual(['map-a', 'map-b']);
  });

  it('rejects an unknown map record id', async () => {
    const { service, roles, mapRecords } = makeService();
    roles.findOne.mockResolvedValue({ id: 2, key: 'operator' });
    mapRecords.find.mockResolvedValue([{ id: 'map-a' }]);

    await expect(
      service.setMapScope(2, { mapRecordIds: ['map-a', 'map-does-not-exist'] }),
    ).rejects.toThrow('Bản đồ không tồn tại: map-does-not-exist');
  });

  it('refuses to scope the admin role', async () => {
    const { service, roles } = makeService();
    roles.findOne.mockResolvedValue({ id: 1, key: 'admin' });

    await expect(
      service.setMapScope(1, { mapRecordIds: ['map-a'] }),
    ).rejects.toThrow(
      'Vai trò quản trị luôn không giới hạn — không gán được phạm vi bản đồ.',
    );
  });

  it('throws NotFound for a role that does not exist', async () => {
    const { service, roles } = makeService();
    roles.findOne.mockResolvedValue(null);

    await expect(
      service.setMapScope(999, { mapRecordIds: [] }),
    ).rejects.toThrow('Không tìm thấy vai trò.');
  });

  it('an empty array clears the scope back to unrestricted, without validating any map id', async () => {
    const { service, roles, roleMapScopes, mapRecords } = makeService();
    roles.findOne.mockResolvedValue({
      id: 2,
      key: 'operator',
      name: 'Operator',
    });
    roles.find.mockResolvedValue([
      {
        id: 2,
        key: 'operator',
        name: 'Operator',
        description: null,
        isSystem: false,
      },
    ]);
    roleMapScopes.find.mockResolvedValue([]);

    const result = await service.setMapScope(2, { mapRecordIds: [] });

    expect(mapRecords.find).not.toHaveBeenCalled();
    expect(roleMapScopes.delete).toHaveBeenCalledWith({ roleId: 2 });
    expect(roleMapScopes.insert).not.toHaveBeenCalled();
    expect(result.mapScope).toBeNull();
  });
});
