import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PermissionEntity } from '../users/entities/permission.entity';
import { RoleEntity } from '../users/entities/role.entity';
import { RolePermissionEntity } from '../users/entities/role-permission.entity';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_CATALOGUE,
  SYSTEM_ROLE_GRANTS,
  rolesGrantedOnIntroduction,
} from './permission.catalogue';

/**
 * Keeps the `permissions` table in sync with the code catalogue on every boot, and seeds the
 * baseline grants for the system roles the first time they have none — so a fresh database is
 * usable and later UI edits to those roles are never clobbered.
 */
@Injectable()
export class PermissionCatalogueService implements OnModuleInit {
  private readonly logger = new Logger(PermissionCatalogueService.name);

  constructor(
    @InjectRepository(PermissionEntity)
    private readonly permissions: Repository<PermissionEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(RolePermissionEntity)
    private readonly rolePermissions: Repository<RolePermissionEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.syncCatalogue();
      await this.seedSystemGrants();
    } catch (error) {
      // DB may not be ready at boot in some environments; the migration + `npm run seed`
      // path still covers a fresh install.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Permission catalogue sync skipped: ${detail}`);
    }
  }

  /**
   * Upsert every catalogue row; drop rows whose key was removed from code. A key that is new to
   * an existing database is granted to the roles its `defaultGrant` names, so adding a screen /
   * UI / column key never hides something a role could already see.
   */
  async syncCatalogue(): Promise<void> {
    const before = await this.permissions.find({ select: { key: true } });
    const previouslyKnown = new Set(before.map((p) => p.key));

    const rows = PERMISSION_CATALOGUE.map((p, index) => ({
      key: p.key,
      cluster: p.cluster,
      screen: p.screen,
      groupKey: p.group,
      kind: p.kind,
      parentKey: p.parent ?? null,
      isDangerous: !!p.dangerous,
      sort: index,
      labelVi: p.labelVi,
      labelEn: p.labelEn,
      labelJa: p.labelJa,
    }));
    await this.permissions.upsert(rows, ['key']);

    const known = new Set(rows.map((r) => r.key));
    const stale = [...previouslyKnown].filter((key) => !known.has(key));
    if (stale.length) {
      await this.permissions.delete(stale);
      this.logger.log(
        `Removed ${stale.length} stale permission(s): ${stale.join(', ')}`,
      );
    }

    const isExistingDatabase = previouslyKnown.size > 0;
    if (isExistingDatabase) {
      const introduced = PERMISSION_CATALOGUE.filter(
        (p) => !previouslyKnown.has(p.key),
      );
      if (introduced.length) await this.grantIntroduced(introduced);
    }
    this.logger.log(`Permission catalogue: ${rows.length} key(s) ensured.`);
  }

  private async grantIntroduced(
    introduced: typeof PERMISSION_CATALOGUE,
  ): Promise<void> {
    const [roles, grants] = await Promise.all([
      this.roles.find(),
      this.rolePermissions.find(),
    ]);
    const editable = roles.filter((r) => !r.fullAccess && r.key !== 'admin');
    const customGrants = new Map<number, Set<string>>(
      editable
        .filter((r) => !(r.key in SYSTEM_ROLE_GRANTS))
        .map((r) => [r.id, new Set()]),
    );
    const seededRoleIds = new Set<number>();
    for (const g of grants) {
      customGrants.get(g.roleId)?.add(g.permissionKey);
      seededRoleIds.add(g.roleId);
    }
    const systemRoles = editable.filter(
      (r) => r.key in SYSTEM_ROLE_GRANTS && seededRoleIds.has(r.id),
    );

    const inserts: { roleId: number; permissionKey: string }[] = [];
    for (const p of introduced) {
      for (const roleId of rolesGrantedOnIntroduction(p, customGrants))
        inserts.push({ roleId, permissionKey: p.key });
      for (const role of systemRoles) {
        if (SYSTEM_ROLE_GRANTS[role.key].includes(p.key))
          inserts.push({ roleId: role.id, permissionKey: p.key });
      }
    }
    if (inserts.length) {
      await this.rolePermissions
        .createQueryBuilder()
        .insert()
        .values(inserts)
        .orIgnore()
        .execute();
    }
    this.logger.log(
      `Introduced ${introduced.length} permission key(s); ${inserts.length} grant(s) added to existing roles.`,
    );
  }

  /**
   * Every full-access role (admin, and any role marked as admin) mirrors the full catalogue as
   * it grows; each other system role with zero grants gets its baseline set.
   */
  async seedSystemGrants(): Promise<void> {
    const fullAccessRoles = await this.roles.find({
      where: [{ fullAccess: true }, { key: 'admin' }],
    });
    for (const role of fullAccessRoles)
      await this.setRolePermissions(role.id, ALL_PERMISSION_KEYS);
    const mirrored = new Set(fullAccessRoles.map((r) => r.key));

    for (const [key, grantKeys] of Object.entries(SYSTEM_ROLE_GRANTS)) {
      if (mirrored.has(key)) continue;
      const role = await this.roles.findOne({ where: { key } });
      if (!role) continue;

      const count = await this.rolePermissions.count({
        where: { roleId: role.id },
      });
      if (count === 0) {
        await this.setRolePermissions(role.id, grantKeys);
        this.logger.log(
          `Seeded ${grantKeys.length} grant(s) for role "${key}".`,
        );
      }
    }
  }

  private async setRolePermissions(
    roleId: number,
    keys: string[],
  ): Promise<void> {
    const catalogueKeys = new Set(PERMISSION_CATALOGUE.map((p) => p.key));
    const valid = [...new Set(keys)].filter((k) => catalogueKeys.has(k));
    await this.rolePermissions.delete({ roleId });
    if (valid.length) {
      await this.rolePermissions.insert(
        valid.map((permissionKey) => ({ roleId, permissionKey })),
      );
    }
  }
}
