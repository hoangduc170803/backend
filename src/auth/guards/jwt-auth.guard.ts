import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { PermissionsService } from '../permissions.service';
import { extractBearerLikeToken, isJwtShaped } from '../token-extract.util';
import type { AuthUser } from '../jwt-payload';

/**
 * Normal login/permanent tokens are JWTs, verified by `JwtStrategy` via Passport. A pasted
 * opaque token (from another system) isn't a JWT at all, so it can never pass that
 * verification — this guard detects the shape up front and, for a non-JWT bearer value,
 * resolves it directly against `api_tokens.token_hash` instead of delegating to Passport.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly permissions: PermissionsService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearerLikeToken(req);

    if (!token || isJwtShaped(token)) {
      return super.canActivate(context) as Promise<boolean>;
    }

    const user = await this.permissions.resolveAuthUserForApiKey(token);
    if (!user) {
      throw new UnauthorizedException('Token không hợp lệ hoặc đã bị thu hồi.');
    }
    (req as Request & { user: AuthUser }).user = user;
    return true;
  }
}
