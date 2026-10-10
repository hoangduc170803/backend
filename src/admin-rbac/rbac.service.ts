import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RoleEntity } from '../users/entities/role.entity';
import { RolePermissionEntity } from '../users/entities/role-permission.entity';
import { RoleMapScopeEntity } from '../users/entities/role-map-scope.entity';
import { UserRoleEntity } from '../users/entities/user-role.entity';
import { MapRecordEntity } from '../maps/infrastructure/entities/map-record.entity';
import { PermissionsService } from '../auth/permissions.service';
import {
  ALL_PERMISSION_KEYS,
  IMPLICIT_VIEW_PERMISSIONS,
  PERMISSION_CATALOGUE,
} from '../auth/permission.catalogue';
import { PermissionEntity } from '../users/entities/permission.entity';
import type {
  CreateRoleDto,
  UpdateRoleDto,
  SetRoleMapScopeDto,
} from './dto/rbac.dto';

export interface RoleDto {
  id: number;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** Marked as admin: always holds the whole catalogue, including keys added later. */
  fullAccess: boolean;
  userCount: number;
  permissions: string[];
  /** Map record ids this role is restricted to; `null` = unrestricted (sees/acts on every map). */
  mapScope: string[] | null;
}

export interface PermissionCatalogueDto {
  /** Screen keys in nav order. */
  screens: string[];
  /** Legacy grouping, kept for older clients. */
  clusters: string[];
  permissions: {
    key: string;
    cluster: string;
    screen: string;
    group: string;
    kind: string;
    parent: string | null;
    dangerous: boolean;
    /** Always granted to every signed-in user — shown locked in the editor. */
    implicit: boolean;
    labelVi: string;
    labelEn: string;
    labelJa: string;
  }[];
}

const CATALOGUE_KEYS = new Set(PERMISSION_CATALOGUE.map((p) => p.key));
const MANAGER_KEYS = ['users.manage', 'roles.manage'];

@Injectable()
export class RbacService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(RolePermissionEntity)
    private readonly rolePermissions: Repository<RolePermissionEntity>,
    @InjectRepository(RoleMapScopeEntity)
    private readonly roleMapScopes: Repository<RoleMapScopeEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoles: Repository<UserRoleEntity>,
    @InjectRepository(MapRecordEntity)
    private readonly mapRecords: Repository<MapRecordEntity>,
    @InjectRepository(PermissionEntity)
    private readonly permissionRows: Repository<PermissionEntity>,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * The checklist the role editor renders, read back from the `permissions` table (kept in sync
   * with the code catalogue at boot), in catalogue order: screens in nav order, then each
   * screen's sections, then keys.
   */
  async catalogue(): Promise<PermissionCatalogueDto> {
    const rows = await this.permissionRows.find({ order: { sort: 'ASC' } });
    const screens: string[] = [];
    const clusters: string[] = [];
    for (const p of rows) {
      if (!screens.includes(p.screen)) screens.push(p.screen);
      if (!clusters.includes(p.cluster)) clusters.push(p.cluster);
    }
    return {
      screens,
      clusters,
      permissions: rows.map((p) => ({
        key: p.key,
        cluster: p.cluster,
        screen: p.screen,
        group: p.groupKey,
        kind: p.kind,
        parent: p.parentKey,
        dangerous: p.isDangerous,
        implicit: (IMPLICIT_VIEW_PERMISSIONS as readonly string[]).includes(
          p.key,
        ),
        labelVi: p.labelVi ?? p.key,
        labelEn: p.labelEn ?? p.key,
        labelJa: p.labelJa ?? p.key,
      })),
    };
  }

  async list(): Promise<RoleDto[]> {
    const [roles, grants, scopes, counts] = await Promise.all([
      this.roles.find({ order: { isSystem: 'DESC', name: 'ASC' } }),
      this.rolePermissions.find(),
      this.roleMapScopes.find(),
      this.userRoles
        .createQueryBuilder('ur')
        .select('ur.role_id', 'roleId')
        .addSelect('COUNT(*)', 'count')
        .groupBy('ur.role_id')
        .getRawMany<{ roleId: number; count: string }>(),
    ]);

    const grantsByRole = new Map<number, string[]>();
    for (const g of grants) {
      const arr = grantsByRole.get(g.roleId) ?? [];
      arr.push(g.permissionKey);
      grantsByRole.set(g.roleId, arr);
    }
    const scopeByRole = new Map<number, string[]>();
    for (const s of scopes) {
      const arr = scopeByRole.get(s.roleId) ?? [];
      arr.push(s.mapRecordId);
      scopeByRole.set(s.roleId, arr);
    }
    const countByRole = new Map(
      counts.map((c) => [Number(c.roleId), Number(c.count)]),
    );

    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      fullAccess: r.fullAccess,
      userCount: countByRole.get(r.id) ?? 0,
      permissions: r.fullAccess
        ? [...ALL_PERMISSION_KEYS].sort()
        : (grantsByRole.get(r.id) ?? []).sort(),
      mapScope: scopeByRole.get(r.id)?.sort() ?? null,
    }));
  }

  async create(dto: CreateRoleDto): Promise<RoleDto> {
    const existing = await this.roles.findOne({ where: { key: dto.key } });
    if (existing) throw new ConflictException('Mã vai trò đã tồn tại.');

    const role = await this.roles.save(
      this.roles.create({
        key: dto.key,
        name: dto.name,
        description: dto.description ?? null,
        isSystem: false,
      }),
    );
    await this.writeGrants(role.id, dto.permissions);
    this.permissions.refresh();
    return this.oneOrFail(role.id);
  }

  async update(id: number, dto: UpdateRoleDto): Promise<RoleDto> {
    const role = await this.roles.findOne({ where: { id } });
    if (!role) throw new NotFoundException('Không tìm thấy vai trò.');

    const isAdminRole = role.key === 'admin';
    if (dto.fullAccess === false && isAdminRole) {
      throw new BadRequestException(
        'Vai trò quản trị luôn có toàn bộ quyền — không bỏ đánh dấu admin được.',
      );
    }
    const fullAccess = isAdminRole || (dto.fullAccess ?? role.fullAccess);
    if (dto.permissions && fullAccess) {
      throw new BadRequestException(
        'Vai trò đánh dấu admin luôn có toàn bộ quyền — không chỉnh được ma trận.',
      );
    }
    if (dto.permissions) {
      await this.assertManagerCoverage(role.id, dto.permissions);
      await this.writeGrants(role.id, dto.permissions);
    }
    if (fullAccess && !role.fullAccess)
      await this.writeGrants(role.id, ALL_PERMISSION_KEYS);
    if (
      dto.name !== undefined ||
      dto.description !== undefined ||
      fullAccess !== role.fullAccess
    ) {
      if (dto.name !== undefined) role.name = dto.name;
      if (dto.description !== undefined)
        role.description = dto.description || null;
      role.fullAccess = fullAccess;
      await this.roles.save(role);
    }
    this.permissions.refresh();
    return this.oneOrFail(role.id);
  }

  async remove(id: number): Promise<void> {
    const role = await this.roles.findOne({ where: { id } });
    if (!role) throw new NotFoundException('Không tìm thấy vai trò.');
    if (role.isSystem) {
      throw new BadRequestException('Không thể xoá vai trò hệ thống.');
    }
    const count = await this.userRoles.count({ where: { roleId: id } });
    if (count > 0) {
      throw new BadRequestException(
        `Còn ${count} người dùng đang giữ vai trò này — hãy chuyển họ sang vai trò khác trước.`,
      );
    }
    await this.rolePermissions.delete({ roleId: id });
    await this.roles.delete(id);
    this.permissions.refresh();
  }

  /**
   * Restrict a role to exactly this set of maps (AUTH-3). An empty array clears the scope back
   * to unrestricted — that's the intended way to un-scope a role, not an error.
   */
  async setMapScope(id: number, dto: SetRoleMapScopeDto): Promise<RoleDto> {
    const role = await this.roles.findOne({ where: { id } });
    if (!role) throw new NotFoundException('Không tìm thấy vai trò.');
    if (role.key === 'admin') {
      throw new BadRequestException(
        'Vai trò quản trị luôn không giới hạn — không gán được phạm vi bản đồ.',
      );
    }

    const mapRecordIds = [...new Set(dto.mapRecordIds)];
    if (mapRecordIds.length > 0) {
      const found = await this.mapRecords.find({
        where: { id: In(mapRecordIds) },
        select: { id: true },
        withDeleted: true,
      });
      const foundIds = new Set(found.map((m) => m.id));
      const unknown = mapRecordIds.filter((mapId) => !foundIds.has(mapId));
      if (unknown.length) {
        throw new BadRequestException(
          `Bản đồ không tồn tại: ${unknown.join(', ')}`,
        );
      }
    }

    await this.roleMapScopes.manager.transaction(async (manager) => {
      // Serialize replacements of the same role; a failed insert rolls back its delete.
      await manager.getRepository(RoleEntity).findOneOrFail({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      const scopes = manager.getRepository(RoleMapScopeEntity);
      await scopes.delete({ roleId: id });
      if (mapRecordIds.length > 0) {
        await scopes.insert(
          mapRecordIds.map((mapRecordId) => ({ roleId: id, mapRecordId })),
        );
      }
    });
    this.permissions.refresh();
    return this.oneOrFail(id);
  }

  private async writeGrants(roleId: number, keys: string[]): Promise<void> {
    const valid = [...new Set(keys)].filter((k) => CATALOGUE_KEYS.has(k));
    const unknown = keys.filter((k) => !CATALOGUE_KEYS.has(k));
    if (unknown.length) {
      throw new BadRequestException(
        `Quyền không hợp lệ: ${unknown.join(', ')}`,
      );
    }
    await this.rolePermissions.delete({ roleId });
    if (valid.length) {
      await this.rolePermissions.insert(
        valid.map((permissionKey) => ({ roleId, permissionKey })),
      );
    }
  }

  /** Refuse an edit that would leave no role granting users.manage / roles.manage. */
  private async assertManagerCoverage(
    roleId: number,
    nextKeys: string[],
  ): Promise<void> {
    const next = new Set(nextKeys);
    for (const managerKey of MANAGER_KEYS) {
      if (next.has(managerKey)) continue;
      const others = await this.rolePermissions.find({
        where: { permissionKey: managerKey },
      });
      const stillCovered = others.some((g) => g.roleId !== roleId);
      if (!stillCovered) {
        throw new BadRequestException(
          `Phải còn ít nhất một vai trò giữ quyền "${managerKey}".`,
        );
      }
    }
  }

  private async oneOrFail(id: number): Promise<RoleDto> {
    const all = await this.list();
    const found = all.find((r) => r.id === id);
    if (!found) throw new NotFoundException('Không tìm thấy vai trò.');
    return found;
  }
}
