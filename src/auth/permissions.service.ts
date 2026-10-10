import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { RoleEntity } from '../users/entities/role.entity';
import { RolePermissionEntity } from '../users/entities/role-permission.entity';
import { RoleMapScopeEntity } from '../users/entities/role-map-scope.entity';
import { ApiTokenEntity } from '../users/entities/api-token.entity';
import { UsersService } from '../users/users.service';
import {
  ALL_PERMISSION_KEYS,
  IMPLICIT_VIEW_PERMISSIONS,
  effectivePermissions,
} from './permission.catalogue';
import type { AuthUser } from './jwt-payload';

const STALE_LAST_USED_MS = 5 * 60_000;

/**
 * Resolves a role key to its effective permission set, cached in memory and invalidated
 * whenever a role or the matrix changes (`refresh()`), so an admin's edit takes effect on the
 * very next request without re-issuing tokens. Also gates both kinds of permanent token
 * (system-generated `jti` JWTs and pasted opaque strings looked up by hash).
 */
@Injectable()
export class PermissionsService {
  private cache = new Map<string, Set<string>>();
  /** `undefined` is a valid cached value (unrestricted) — `.has()` distinguishes that from "not cached yet". */
  private mapScopeCache = new Map<string, string[] | undefined>();

  constructor(
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(RolePermissionEntity)
    private readonly rolePermissions: Repository<RolePermissionEntity>,
    @InjectRepository(RoleMapScopeEntity)
    private readonly roleMapScopes: Repository<RoleMapScopeEntity>,
    @InjectRepository(ApiTokenEntity)
    private readonly apiTokens: Repository<ApiTokenEntity>,
    private readonly users: UsersService,
  ) {}

  /** Drop the cache — call after any role / role_permissions / role_map_scopes mutation. */
  refresh(): void {
    this.cache.clear();
    this.mapScopeCache.clear();
  }

  /**
   * Effective permissions for a role key: grants ∪ implicit read permissions, minus any key
   * whose parent chain is not fully granted.
   */
  async getRolePermissions(
    roleKey: string | null | undefined,
  ): Promise<Set<string>> {
    const key = roleKey ?? '';
    const cached = this.cache.get(key);
    if (cached) return cached;

    const granted = new Set<string>(IMPLICIT_VIEW_PERMISSIONS);
    if (key) {
      const role = await this.roles.findOne({ where: { key } });
      if (role?.fullAccess) {
        ALL_PERMISSION_KEYS.forEach((k) => granted.add(k));
      } else if (role) {
        const rows = await this.rolePermissions.find({
          where: { roleId: role.id },
        });
        rows.forEach((r) => granted.add(r.permissionKey));
      }
    }
    const perms = effectivePermissions(granted);
    this.cache.set(key, perms);
    return perms;
  }

  async hasPermission(
    roleKey: string | null | undefined,
    permission: string,
  ): Promise<boolean> {
    return (await this.getRolePermissions(roleKey)).has(permission);
  }

  /**
   * Map records a role is restricted to, or `undefined` if the role has no scope rows
   * (unrestricted — sees/acts on every map, identical to today's behavior). See
   * `createAppAbility`'s `mapIds` contract in `./ability.ts`.
   */
  async getRoleMapScope(
    roleKey: string | null | undefined,
  ): Promise<string[] | undefined> {
    const key = roleKey ?? '';
    if (this.mapScopeCache.has(key)) return this.mapScopeCache.get(key);

    let scope: string[] | undefined;
    if (key) {
      const role = await this.roles.findOne({ where: { key } });
      if (role) {
        const rows = await this.roleMapScopes.find({
          where: { roleId: role.id },
        });
        if (rows.length > 0) scope = rows.map((r) => r.mapRecordId);
      }
    }
    this.mapScopeCache.set(key, scope);
    return scope;
  }

  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * For a system-generated permanent token: confirm the `jti` row exists and is not revoked.
   * Returns the owning userId, or null if the token should be rejected. Bumps `last_used_at`
   * at most once every few minutes.
   */
  async resolveApiToken(jti: string): Promise<string | null> {
    const row = await this.apiTokens.findOne({ where: { jti } });
    if (!row || row.revokedAt) return null;
    await this.touchLastUsed(row);
    return row.userId;
  }

  async isTokenHashTaken(hash: string): Promise<boolean> {
    return (await this.apiTokens.count({ where: { tokenHash: hash } })) > 0;
  }

  /**
   * For a pasted opaque token: look it up by hash, confirm the owning account can still
   * authenticate, and resolve a ready-to-use `AuthUser` — the guard sets this on the request
   * directly, bypassing JWT verification entirely (there is no JWT to verify).
   */
  async resolveAuthUserForApiKey(rawToken: string): Promise<AuthUser | null> {
    const row = await this.apiTokens.findOne({
      where: { tokenHash: this.hashToken(rawToken) },
    });
    if (!row || row.revokedAt) return null;

    const auth = await this.users.authStateOf(row.userId);
    if (!auth || auth.isLocked || (!auth.isActive && !auth.isInvited))
      return null;

    const user = await this.users.findByIdOrFail(row.userId);
    const role = this.users.feRoleOf(user);
    const perms = await this.getRolePermissions(role);
    const mapIds = await this.getRoleMapScope(role);
    await this.touchLastUsed(row);

    return {
      sub: row.userId,
      username: user.username,
      role,
      roles: [role],
      perms: [...perms],
      mapIds,
      mustChangePassword: false,
    };
  }

  private async touchLastUsed(row: ApiTokenEntity): Promise<void> {
    if (
      !row.lastUsedAt ||
      Date.now() - row.lastUsedAt.getTime() > STALE_LAST_USED_MS
    ) {
      await this.apiTokens.update({ id: row.id }, { lastUsedAt: new Date() });
    }
  }
}
