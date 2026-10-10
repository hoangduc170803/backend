import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserEntity } from './entities/user.entity';
import { RoleEntity } from './entities/role.entity';
import { UserRoleEntity } from './entities/user-role.entity';
import { UserSessionEntity } from './entities/user-session.entity';
import { UserPreferenceEntity } from './entities/user-preference.entity';
import {
  type AccountUserDto,
  type AdminUserDto,
  type FeRole,
  toAccountUser,
  toAdminUser,
} from './user.mapper';

const BCRYPT_ROUNDS = 10;

export interface CreateUserData {
  name: string;
  username: string;
  email: string;
  phone?: string;
  shift?: string;
  role: FeRole;
  sendInvite?: boolean;
  password?: string;
  mustChangePassword?: boolean;
}

export interface ProfilePatch {
  name?: string;
  email?: string;
  phone?: string;
  shift?: string;
  photo?: string | null;
}

export interface AdminListParams {
  search?: string;
  role?: FeRole;
  status?: AdminUserDto['status'] | 'all';
}

export interface AuthState {
  isLocked: boolean;
  isActive: boolean;
  isInvited: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: Date;
  roleKey: FeRole;
}

@Injectable()
export class UsersService implements OnModuleInit {
  private roleIdByKey = new Map<string, number>();
  private roleNameByKey = new Map<string, string>();

  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(UserRoleEntity)
    private readonly userRoles: Repository<UserRoleEntity>,
    @InjectRepository(UserSessionEntity)
    private readonly sessions: Repository<UserSessionEntity>,
    @InjectRepository(UserPreferenceEntity)
    private readonly prefs: Repository<UserPreferenceEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.loadRoles();
    } catch {
      // DB may not be ready at boot; roles are loaded lazily on first use.
    }
  }

  private async loadRoles(): Promise<void> {
    const rows = await this.roles.find();
    this.roleIdByKey = new Map(rows.map((r) => [r.key, r.id]));
    this.roleNameByKey = new Map(rows.map((r) => [r.key, r.name]));
  }

  private async roleId(key: string): Promise<number> {
    if (!this.roleIdByKey.has(key)) await this.loadRoles();
    const id = this.roleIdByKey.get(key);
    if (id == null) throw new NotFoundException(`Role ${key} not found`);
    return id;
  }

  feRoleOf(user: UserEntity): FeRole {
    return user.userRoles?.[0]?.role?.key ?? 'operator';
  }

  roleNameOf(user: UserEntity): string {
    const role = user.userRoles?.[0]?.role;
    return (
      role?.name ?? this.roleNameByKey.get(this.feRoleOf(user)) ?? 'Operator'
    );
  }

  private withRoles() {
    return { relations: { userRoles: { role: true } } } as const;
  }

  findByUsername(username: string): Promise<UserEntity | null> {
    return this.users.findOne({ where: { username }, ...this.withRoles() });
  }

  findByEmail(email: string): Promise<UserEntity | null> {
    return this.users.findOne({ where: { email } });
  }

  async findByIdOrFail(id: string): Promise<UserEntity> {
    const user = await this.users.findOne({
      where: { id },
      ...this.withRoles(),
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async accountOf(id: string): Promise<AccountUserDto> {
    const user = await this.findByIdOrFail(id);
    return toAccountUser(user, this.feRoleOf(user), this.roleNameOf(user));
  }

  // ── Admin listing ─────────────────────────────────────────────────────────
  async listAdmin(params: AdminListParams = {}): Promise<AdminUserDto[]> {
    const all = await this.users.find({
      ...this.withRoles(),
      order: { createdAt: 'DESC' },
    });
    const onlineIds = await this.onlineUserIds();
    const q = params.search?.trim().toLowerCase();

    return all
      .map((u) =>
        toAdminUser(
          u,
          this.feRoleOf(u),
          this.roleNameOf(u),
          onlineIds.has(u.id),
        ),
      )
      .filter((u) => {
        if (params.role && params.role !== 'all' && u.role !== params.role)
          return false;
        if (
          params.status &&
          params.status !== 'all' &&
          u.status !== params.status
        )
          return false;
        if (
          q &&
          !`${u.name} ${u.username} ${u.email}`.toLowerCase().includes(q)
        )
          return false;
        return true;
      });
  }

  async adminUserOf(id: string): Promise<AdminUserDto> {
    const user = await this.findByIdOrFail(id);
    const onlineIds = await this.onlineUserIds();
    return toAdminUser(
      user,
      this.feRoleOf(user),
      this.roleNameOf(user),
      onlineIds.has(user.id),
    );
  }

  private async onlineUserIds(): Promise<Set<string>> {
    const rows = await this.sessions.find({
      where: { logoutAt: IsNull() },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  // ── Mutations ───────────────────────────────────────────────────────────────
  async createUser(
    data: CreateUserData,
    assignedBy?: string,
  ): Promise<UserEntity> {
    const tempPassword = data.password ?? this.randomToken(12);
    const user = this.users.create({
      username: data.username,
      email: data.email,
      fullName: data.name,
      phone: data.phone ?? null,
      shift: data.shift ?? null,
      passwordHash: await bcrypt.hash(tempPassword, BCRYPT_ROUNDS),
      isActive: !data.sendInvite,
      isInvited: !!data.sendInvite,
      mustChangePassword: !!data.mustChangePassword,
    });
    const saved = await this.users.save(user);
    await this.assignRole(saved.id, data.role, assignedBy);
    return this.findByIdOrFail(saved.id);
  }

  async updateProfile(id: string, patch: ProfilePatch): Promise<UserEntity> {
    const user = await this.findByIdOrFail(id);
    if (patch.name !== undefined) user.fullName = patch.name;
    if (patch.email !== undefined) user.email = patch.email;
    if (patch.phone !== undefined) user.phone = patch.phone;
    if (patch.shift !== undefined) user.shift = patch.shift;
    if (patch.photo !== undefined) user.avatarUrl = patch.photo;
    await this.users.save(user);
    return this.findByIdOrFail(id);
  }

  async updateAdmin(
    id: string,
    patch: ProfilePatch & { role?: FeRole },
    assignedBy?: string,
  ): Promise<UserEntity> {
    await this.updateProfile(id, patch);
    if (patch.role) await this.setRole(id, patch.role, assignedBy);
    return this.findByIdOrFail(id);
  }

  /** Enforce exactly one role per user. */
  async setRole(id: string, role: FeRole, assignedBy?: string): Promise<void> {
    await this.userRoles.delete({ userId: id });
    await this.assignRole(id, role, assignedBy);
  }

  private async assignRole(
    userId: string,
    role: FeRole,
    assignedBy?: string,
  ): Promise<void> {
    const roleId = await this.roleId(role);
    await this.userRoles.save(
      this.userRoles.create({ userId, roleId, assignedBy: assignedBy ?? null }),
    );
  }

  async setLock(
    id: string,
    locking: boolean,
    reason?: string,
  ): Promise<UserEntity> {
    const user = await this.findByIdOrFail(id);
    user.isLocked = locking;
    user.lockReason = locking ? (reason ?? user.lockReason ?? null) : null;
    if (!locking && !user.isInvited) user.isActive = true;
    await this.users.save(user);
    return this.findByIdOrFail(id);
  }

  async remove(id: string): Promise<UserEntity> {
    const user = await this.findByIdOrFail(id);
    user.isActive = false;
    user.isInvited = false;
    user.isLocked = false;
    user.lockReason = null;
    await this.users.save(user);
    return this.findByIdOrFail(id);
  }

  async activate(id: string): Promise<UserEntity> {
    const user = await this.findByIdOrFail(id);
    user.isActive = true;
    user.isInvited = false;
    user.isLocked = false;
    user.lockReason = null;
    await this.users.save(user);
    return this.findByIdOrFail(id);
  }

  async activateInvitation(id: string): Promise<void> {
    const user = await this.findByIdOrFail(id);
    if (!user.isInvited || user.isLocked) return;
    user.isActive = true;
    user.isInvited = false;
    await this.users.save(user);
  }

  async setPassword(
    id: string,
    plain: string,
    mustChangePassword = false,
  ): Promise<void> {
    const hash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
    await this.users.update(id, {
      passwordHash: hash,
      mustChangePassword,
      passwordChangedAt: new Date(),
    });
  }

  /** Single lightweight lookup `JwtStrategy` uses to gate every authenticated request.
   *  Loads the current role from the DB too, so authorization never trusts a JWT's baked-in
   *  role claim — a role change takes effect on the very next request, not on next login. */
  async authStateOf(id: string): Promise<AuthState | null> {
    const user = await this.users.findOne({
      where: { id },
      select: {
        id: true,
        isLocked: true,
        isActive: true,
        isInvited: true,
        mustChangePassword: true,
        passwordChangedAt: true,
      },
      relations: { userRoles: { role: true } },
    });
    if (!user) return null;
    return {
      isLocked: user.isLocked,
      isActive: user.isActive,
      isInvited: user.isInvited,
      mustChangePassword: user.mustChangePassword,
      passwordChangedAt: user.passwordChangedAt,
      roleKey: this.feRoleOf(user),
    };
  }

  verifyPassword(user: UserEntity, plain: string): Promise<boolean> {
    return bcrypt.compare(plain, user.passwordHash);
  }

  async touchLastLogin(id: string): Promise<void> {
    await this.users.update(id, { lastLoginAt: new Date(), isInvited: false });
  }

  // ── Preferences ─────────────────────────────────────────────────────────────
  async getPreferences(userId: string): Promise<UserPreferenceEntity> {
    let pref = await this.prefs.findOne({ where: { userId } });
    if (!pref) {
      pref = this.prefs.create({ userId });
      await this.prefs.save(pref);
    }
    return pref;
  }

  async updatePreferences(
    userId: string,
    patch: Partial<
      Pick<
        UserPreferenceEntity,
        'language' | 'notificationsEnabled' | 'soundEnabled'
      >
    >,
  ): Promise<UserPreferenceEntity> {
    const pref = await this.getPreferences(userId);
    Object.assign(pref, patch, { updatedAt: new Date() });
    return this.prefs.save(pref);
  }

  randomToken(len = 32): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(
      { length: len },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join('');
  }
}
