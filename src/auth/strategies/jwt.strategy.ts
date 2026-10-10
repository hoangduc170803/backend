import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import type { AuthUser, JwtPayload } from '../jwt-payload';
import { PermissionsService } from '../permissions.service';
import { TokenService } from '../token.service';
import { UsersService } from '../../users/users.service';

// EventSource (SSE) cannot set an Authorization header, so the operating screen authenticates
// via the `wes_access` cookie set on login/refresh (cookie-parser runs globally in main.ts).
function fromAccessCookie(req: Request): string | null {
  const cookies = req?.cookies as Record<string, string> | undefined;
  return cookies?.wes_access ?? null;
}

const PASSWORD_GATE_ALLOWLIST: { method: string; path: string }[] = [
  { method: 'GET', path: '/api/account/me' },
  { method: 'POST', path: '/api/account/change-password' },
  { method: 'GET', path: '/api/account/preferences' },
  { method: 'PATCH', path: '/api/account/preferences' },
  { method: 'POST', path: '/api/auth/logout' },
];

function isAllowedWhileMustChangePassword(req: Request): boolean {
  return PASSWORD_GATE_ALLOWLIST.some(
    (rule) => rule.method === req.method && req.path === rule.path,
  );
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly permissions: PermissionsService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromAccessCookie,
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'dev-secret-change-me'),
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<AuthUser> {
    const isPermanentToken = !!payload.jti;
    if (isPermanentToken) {
      const ownerId = await this.permissions.resolveApiToken(payload.jti!);
      if (!ownerId || ownerId !== payload.sub) {
        throw new UnauthorizedException('Token đã bị thu hồi.');
      }
    }

    const auth = await this.users.authStateOf(payload.sub);
    if (!auth) {
      throw new UnauthorizedException('Tài khoản không tồn tại.');
    }
    if (auth.isLocked) {
      throw new UnauthorizedException(
        'Tài khoản đã bị khoá — vui lòng đăng nhập lại.',
      );
    }
    if (!auth.isActive && !auth.isInvited) {
      throw new UnauthorizedException('Tài khoản không còn hoạt động.');
    }

    // Tokens minted before `sid` existed have none — skip rather than reject, for a smooth
    // rollover; every token issued from here on carries one and is checked.
    if (!isPermanentToken && payload.sid) {
      const active = await this.tokens.sessionActive(payload.sid);
      if (!active) {
        throw new UnauthorizedException(
          'Phiên đã đăng xuất — vui lòng đăng nhập lại.',
        );
      }
    }

    // A lock/deactivate can only be caught by re-checking live state on every request
    // (above); a password change can additionally be caught by comparing token age —
    // any token issued before the change is stale, forcing a fresh login. Permanent
    // tokens aren't password-based, so this comparison doesn't apply to them.
    if (!isPermanentToken) {
      // `iat` is whole seconds per the JWT spec; floor passwordChangedAt the same way so a
      // token issued in the same second as the password change isn't falsely rejected.
      const passwordChangedAtSec = Math.floor(
        auth.passwordChangedAt.getTime() / 1000,
      );
      if ((payload.iat ?? 0) < passwordChangedAtSec) {
        throw new UnauthorizedException(
          'Mật khẩu vừa được đổi — vui lòng đăng nhập lại.',
        );
      }
    }

    const mustChangePassword = isPermanentToken
      ? false
      : auth.mustChangePassword;
    if (mustChangePassword && !isAllowedWhileMustChangePassword(req)) {
      throw new ForbiddenException('Bạn phải đổi mật khẩu trước khi tiếp tục.');
    }

    // Role always comes from the live DB state (`auth.roleKey`), never from the token's own
    // `role` claim — a role downgrade (or a permanent token minted before one) must take effect
    // on the very next request, not linger until the token expires.
    const role = auth.roleKey;
    const perms = await this.permissions.getRolePermissions(role);
    const mapIds = await this.permissions.getRoleMapScope(role);

    return {
      sub: payload.sub,
      username: payload.username,
      role,
      roles: [role],
      perms: [...perms],
      mapIds,
      jti: payload.jti,
      sid: payload.sid,
      mustChangePassword,
    };
  }
}
