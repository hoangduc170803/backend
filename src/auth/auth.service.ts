import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { TokenService } from './token.service';
import { MailService } from '../mail/mail.service';
import { toAccountUser, type AccountUserDto } from '../users/user.mapper';
import { UserEntity } from '../users/entities/user.entity';

export interface LoginResult {
  token: string;
  refreshToken: string;
  user: AccountUserDto;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtl: string;

  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessTtl = config.get<string>('JWT_ACCESS_TTL', '1d');
  }

  private signAccess(user: UserEntity, sessionId: string | null): string {
    const role = this.users.feRoleOf(user);
    const payload = {
      sub: user.id,
      username: user.username,
      role,
      roles: [role],
      sid: sessionId,
    };
    const options = { expiresIn: this.accessTtl } as JwtSignOptions;
    return this.jwt.sign(payload, options);
  }

  /**
   * A permanent (no-`exp`) token for a customer / kiosk client, mirroring
   * `Authenticator.signJwt(user, ttl<=0)` in FMS-SRC. The `jti` is checked against
   * `api_tokens` on every request, so revoking the row kills the token instantly.
   */
  signPermanent(user: UserEntity, jti: string): string {
    const role = this.users.feRoleOf(user);
    const payload = {
      sub: user.id,
      username: user.username,
      role,
      roles: [role],
      jti,
    };
    return this.jwt.sign(payload);
  }

  private assertCanAuthenticate(user: UserEntity): void {
    if (user.isLocked) throw new UnauthorizedException('Tai khoan da bi khoa.');
    if (!user.isActive || user.isInvited) {
      throw new UnauthorizedException(
        'Tai khoan chua duoc kich hoat hoac da bi vo hieu hoa.',
      );
    }
  }

  // UC-81
  async login(
    username: string,
    password: string,
    ip: string | null,
    ua: string | null,
  ): Promise<LoginResult> {
    const user = await this.users.findByUsername(username);
    if (!user)
      throw new UnauthorizedException(
        'Tên đăng nhập hoặc mật khẩu không đúng.',
      );
    this.assertCanAuthenticate(user);
    const ok = await this.users.verifyPassword(user, password);
    if (!ok)
      throw new UnauthorizedException(
        'Tên đăng nhập hoặc mật khẩu không đúng.',
      );

    await this.users.touchLastLogin(user.id);
    const sessionId = await this.tokens.startSession(user.id, ip, ua);

    return {
      token: this.signAccess(user, sessionId),
      refreshToken: await this.tokens.issueRefreshToken(user.id, sessionId),
      user: toAccountUser(
        user,
        this.users.feRoleOf(user),
        this.users.roleNameOf(user),
      ),
    };
  }

  // UC-82 — ends only the calling device's session; other devices keep working. Admin-forced
  // lock/remove/reset still goes through `tokens.endAllSessions`.
  async logout(
    userId: string,
    sessionId: string | null,
    refreshToken?: string,
  ): Promise<void> {
    if (refreshToken) await this.tokens.revokeRefreshToken(refreshToken);
    if (sessionId) await this.tokens.endSession(sessionId);
  }

  async refresh(refreshToken?: string): Promise<LoginResult> {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    const rotated = await this.tokens.rotateRefreshToken(refreshToken);
    if (!rotated)
      throw new UnauthorizedException('Refresh token không hợp lệ.');
    const user = await this.users.findByIdOrFail(rotated.userId);
    try {
      this.assertCanAuthenticate(user);
    } catch (error) {
      await this.tokens.revokeAllRefreshTokens(user.id);
      throw error;
    }
    return {
      token: this.signAccess(user, rotated.sessionId),
      refreshToken: rotated.token,
      user: toAccountUser(
        user,
        this.users.feRoleOf(user),
        this.users.roleNameOf(user),
      ),
    };
  }

  // UC-86 — always succeed silently to avoid account enumeration.
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return;
    if (user.isLocked || (!user.isActive && !user.isInvited)) return;
    const raw = await this.tokens.createResetToken(user.id);
    const link = this.mail.passwordResetUrl(raw);
    try {
      await this.mail.sendPasswordReset({
        to: user.email,
        name: user.fullName,
        link,
      });
    } catch (error) {
      // Keep the public forgot-password endpoint non-enumerating.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Password reset email failed for ${email}: ${detail}`);
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await this.tokens.consumeResetToken(token);
    if (!userId)
      throw new BadRequestException('Token không hợp lệ hoặc đã hết hạn.');
    const user = await this.users.findByIdOrFail(userId);
    if (user.isLocked || (!user.isActive && !user.isInvited)) {
      throw new BadRequestException('Tai khoan khong hoat dong.');
    }
    await this.users.setPassword(userId, newPassword);
    if (user.isInvited) await this.users.activateInvitation(userId);
    await this.tokens.revokeAllRefreshTokens(userId);
  }
}
