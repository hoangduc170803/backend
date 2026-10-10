import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { subject } from '@casl/ability';
import { createAppAbility } from '../../auth/ability';
import type { AuthUser } from '../../auth/jwt-payload';
import { ActiveMapContext } from '../infrastructure/active-map-context.service';

/** Covers live-map aliases as well as the scoped library endpoints. */
@Injectable()
export class ActiveMapScopeGuard implements CanActivate {
  constructor(private readonly activeMap: ActiveMapContext) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user: AuthUser }>().user;
    if (user.mapIds === undefined) return true;
    const id = await this.activeMap.id();
    if (
      !id ||
      !createAppAbility(user.perms, user.mapIds).can(
        'read',
        subject('Map', { id }),
      )
    ) {
      throw new ForbiddenException(
        'Bản đồ đang tải nằm ngoài phạm vi được phép.',
      );
    }
    return true;
  }
}
