import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import type { AuthUser } from '../jwt-payload';
import { createAppAbility } from '../ability';

/**
 * Denies the request unless `req.user.perms` (resolved by `JwtStrategy` from the caller's role)
 * contains every key listed by `@RequirePermissions(...)`. Use together with `JwtAuthGuard`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRE_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    const ability = createAppAbility(user?.perms ?? []);
    const missing = required.filter((p) => !ability.can(p, 'Capability'));
    if (missing.length) {
      throw new ForbiddenException(`Thiếu quyền: ${missing.join(', ')}`);
    }
    return true;
  }
}
