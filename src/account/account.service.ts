import { BadRequestException, Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { TokenService } from '../auth/token.service';
import { PermissionsService } from '../auth/permissions.service';
import type { AccountUserDto } from '../users/user.mapper';
import { createAppAbility, AuthorizationRules } from '../auth/ability';
import type {
  ChangePasswordDto,
  UpdatePreferencesDto,
  UpdateProfileDto,
} from './dto/account.dto';

export type MeDto = AccountUserDto & {
  permissions: string[];
  authorization: { version: 1; rules: AuthorizationRules };
};

@Injectable()
export class AccountService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
  ) {}

  // UC-83
  async getMe(userId: string): Promise<MeDto> {
    const account = await this.users.accountOf(userId);
    const perms = await this.permissions.getRolePermissions(account.role);
    const mapIds = await this.permissions.getRoleMapScope(account.role);
    return {
      ...account,
      permissions: [...perms],
      authorization: {
        version: 1,
        rules: createAppAbility([...perms], mapIds).rules,
      },
    };
  }

  // UC-84
  async updateMe(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<AccountUserDto> {
    await this.users.updateProfile(userId, dto);
    return this.users.accountOf(userId);
  }

  // UC-85
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.users.findByIdOrFail(userId);
    const ok = await this.users.verifyPassword(user, dto.currentPassword);
    if (!ok) throw new BadRequestException('Mật khẩu hiện tại không đúng.');
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'Mật khẩu mới phải khác mật khẩu hiện tại.',
      );
    }
    await this.users.setPassword(userId, dto.newPassword);
    // Access tokens already fall over on their `iat` vs `passwordChangedAt` check; refresh
    // tokens don't carry a timestamp comparison, so they must be revoked explicitly here too —
    // otherwise a stolen/older refresh token could keep minting fresh access tokens forever.
    await this.tokens.revokeAllRefreshTokens(userId);
  }

  async revokeOtherSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<void> {
    await this.tokens.endOtherSessions(userId, currentSessionId);
  }

  async getPreferences(userId: string) {
    const p = await this.users.getPreferences(userId);
    return {
      language: p.language,
      notificationsEnabled: p.notificationsEnabled,
      soundEnabled: p.soundEnabled,
    };
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    const p = await this.users.updatePreferences(userId, dto);
    return {
      language: p.language,
      notificationsEnabled: p.notificationsEnabled,
      soundEnabled: p.soundEnabled,
    };
  }
}
