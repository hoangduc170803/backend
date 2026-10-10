import { MessageEvent, UnauthorizedException } from '@nestjs/common';
import { Observable, interval, mergeMap } from 'rxjs';
import { UsersService } from '../users/users.service';
import { TokenService } from './token.service';
import { PermissionsService } from './permissions.service';
import type { AuthUser } from './jwt-payload';

/**
 * SSE `@Sse()` guards only run once, at connect — a logout, session revoke, permanent-token
 * revoke, or account lock/deactivate has no way to reach an already-open stream. Piggybacking
 * the re-check on the existing heartbeat interval closes that gap within one heartbeat period,
 * without a separate pub/sub teardown mechanism. Throwing here completes the underlying
 * Observable with an error, which Nest turns into the stream closing — the client's own
 * reconnect-with-backoff then hits a real 401 via the normal JwtAuthGuard path.
 */
export function sseHeartbeat$(
  intervalMs: number,
  users: UsersService,
  tokens: TokenService,
  permissions: PermissionsService,
  user: AuthUser,
): Observable<MessageEvent> {
  return interval(intervalMs).pipe(
    mergeMap(async () => {
      const auth = await users.authStateOf(user.sub);
      if (!auth || auth.isLocked || (!auth.isActive && !auth.isInvited)) {
        throw new UnauthorizedException('Tài khoản không còn hoạt động.');
      }
      if (user.sid) {
        const active = await tokens.sessionActive(user.sid);
        if (!active) {
          throw new UnauthorizedException(
            'Phiên đã đăng xuất — vui lòng đăng nhập lại.',
          );
        }
      }
      if (user.jti) {
        const ownerId = await permissions.resolveApiToken(user.jti);
        if (!ownerId || ownerId !== user.sub) {
          throw new UnauthorizedException('Token đã bị thu hồi.');
        }
      }
      return { type: 'ping', data: '' };
    }),
  );
}
