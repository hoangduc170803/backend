import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { UsersService, type AdminListParams } from '../users/users.service';
import { TokenService } from '../auth/token.service';
import { PermissionsService } from '../auth/permissions.service';
import { MailService } from '../mail/mail.service';
import type { AdminUserDto } from '../users/user.mapper';
import type {
  CreateAdminUserDto,
  ResetPasswordDto,
  UpdateAdminUserDto,
} from './dto/admin-users.dto';

const SELF_TARGET_MESSAGE =
  'Không thể tự thay đổi vai trò, khoá hoặc xoá tài khoản của chính mình.';
const LAST_MANAGER_MESSAGE =
  'Đây là tài khoản quản trị cuối cùng còn quyền quản lý người dùng — không thể hạ quyền, khoá hoặc xoá.';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
    private readonly mail: MailService,
  ) {}

  list(params: AdminListParams): Promise<AdminUserDto[]> {
    return this.users.listAdmin(params);
  }

  async create(
    dto: CreateAdminUserDto,
    actorId: string,
  ): Promise<AdminUserDto & { inviteSent: boolean | null }> {
    if (dto.password && dto.sendInvite) {
      throw new BadRequestException(
        'Chọn một trong hai: đặt mật khẩu ngay hoặc gửi email mời.',
      );
    }
    if (await this.users.findByUsername(dto.username)) {
      throw new ConflictException('Tên đăng nhập đã tồn tại.');
    }
    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictException('Email đã được sử dụng.');
    }
    const created = await this.users.createUser(dto, actorId);
    const inviteSent = dto.sendInvite
      ? await this.trySendInvite(created.id, created.email, created.fullName)
      : null;
    return { ...(await this.users.adminUserOf(created.id)), inviteSent };
  }

  private async trySendInvite(
    userId: string,
    email: string,
    name: string,
  ): Promise<boolean> {
    try {
      const raw = await this.tokens.createResetToken(userId);
      await this.mail.sendPasswordReset({
        to: email,
        name,
        link: this.mail.passwordResetUrl(raw),
        subject: 'Activate your WES Console account',
        intro:
          'An administrator created a WES Console account for you. Use this link to set your password and activate access.',
      });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Invite email to ${email} failed: ${detail}`);
      return false;
    }
  }

  async update(
    id: string,
    dto: UpdateAdminUserDto,
    actorId: string,
  ): Promise<AdminUserDto> {
    if (dto.role) await this.assertRoleChangeAllowed(id, actorId, dto.role);
    await this.users.updateAdmin(id, dto, actorId);
    return this.users.adminUserOf(id);
  }

  async remove(id: string, actorId: string): Promise<AdminUserDto> {
    await this.assertNotLastManager(id, actorId);
    await this.users.remove(id);
    await this.tokens.revokeAllRefreshTokens(id);
    await this.tokens.endAllSessions(id);
    return this.users.adminUserOf(id);
  }

  async setRole(
    id: string,
    role: string,
    actorId: string,
  ): Promise<AdminUserDto> {
    await this.assertRoleChangeAllowed(id, actorId, role);
    await this.users.setRole(id, role, actorId);
    return this.users.adminUserOf(id);
  }

  async lock(
    id: string,
    reason: string | undefined,
    actorId: string,
  ): Promise<AdminUserDto> {
    await this.assertNotLastManager(id, actorId);
    await this.users.setLock(id, true, reason);
    await this.tokens.revokeAllRefreshTokens(id);
    await this.tokens.endAllSessions(id);
    return this.users.adminUserOf(id);
  }

  async unlock(id: string): Promise<AdminUserDto> {
    await this.users.setLock(id, false);
    return this.users.adminUserOf(id);
  }

  async activate(id: string): Promise<AdminUserDto> {
    await this.users.activate(id);
    return this.users.adminUserOf(id);
  }

  async resetPassword(
    id: string,
    dto: ResetPasswordDto,
  ): Promise<{ password?: string }> {
    if (dto.method === 'temp') {
      return { password: await this.issueTempPassword(id, dto.password) };
    }
    await this.sendResetLink(id);
    return {};
  }

  private async issueTempPassword(
    id: string,
    password: string | undefined,
  ): Promise<string> {
    const user = await this.users.findByIdOrFail(id);
    if (user.isLocked) {
      throw new BadRequestException(
        'Tài khoản đang bị khoá — mở khoá trước khi đặt mật khẩu.',
      );
    }
    if (!user.isActive && !user.isInvited) {
      throw new BadRequestException('Tài khoản đang ngưng hoạt động.');
    }
    const plain = password?.trim() || this.users.randomToken(12);
    await this.users.setPassword(user.id, plain, true);
    if (user.isInvited) await this.users.activateInvitation(user.id);
    await this.tokens.revokeAllRefreshTokens(user.id);
    await this.tokens.endAllSessions(user.id);
    return plain;
  }

  private async sendResetLink(id: string): Promise<void> {
    const user = await this.users.findByIdOrFail(id);
    if (!user.isActive && !user.isInvited) {
      throw new BadRequestException('Tài khoản đang ngưng hoạt động.');
    }
    const raw = await this.tokens.createResetToken(user.id);
    await this.mail.sendPasswordReset({
      to: user.email,
      name: user.fullName,
      link: this.mail.passwordResetUrl(raw),
    });
  }

  private async assertRoleChangeAllowed(
    targetId: string,
    actorId: string,
    nextRole: string,
  ): Promise<void> {
    const nextPerms = await this.permissions.getRolePermissions(nextRole);
    if (nextPerms.has('users.manage')) return;
    await this.assertNotLastManager(targetId, actorId);
  }

  private async assertNotLastManager(
    targetId: string,
    actorId: string,
  ): Promise<void> {
    if (targetId === actorId) {
      throw new BadRequestException(SELF_TARGET_MESSAGE);
    }
    const target = await this.users.findByIdOrFail(targetId);
    const targetPerms = await this.permissions.getRolePermissions(
      this.users.feRoleOf(target),
    );
    if (!targetPerms.has('users.manage')) return;

    const all = await this.users.listAdmin({});
    let managers = 0;
    for (const u of all) {
      if (u.status !== 'active') continue;
      const perms = await this.permissions.getRolePermissions(u.role);
      if (perms.has('users.manage')) managers++;
    }
    if (managers <= 1) {
      throw new BadRequestException(LAST_MANAGER_MESSAGE);
    }
  }
}
