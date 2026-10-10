import { firstValueFrom, take, toArray } from 'rxjs';
import { sseHeartbeat$ } from './sse-heartbeat';
import type { AuthUser } from './jwt-payload';

describe('sseHeartbeat$', () => {
  const baseUser: AuthUser = {
    sub: 'user-1',
    username: 'quan.tran',
    role: 'operator',
    roles: ['operator'],
    perms: [],
    mustChangePassword: false,
  };

  function makeDeps() {
    return {
      users: {
        authStateOf: jest.fn().mockResolvedValue({
          isLocked: false,
          isActive: true,
          isInvited: false,
        }),
      },
      tokens: { sessionActive: jest.fn().mockResolvedValue(true) },
      permissions: { resolveApiToken: jest.fn().mockResolvedValue('user-1') },
    };
  }

  it('emits a ping for an active account with no session or permanent token to re-check', async () => {
    const { users, tokens, permissions } = makeDeps();

    const emission = await firstValueFrom(
      sseHeartbeat$(
        1,
        users as never,
        tokens as never,
        permissions as never,
        baseUser,
      ),
    );

    expect(emission).toEqual({ type: 'ping', data: '' });
    expect(tokens.sessionActive).not.toHaveBeenCalled();
    expect(permissions.resolveApiToken).not.toHaveBeenCalled();
  });

  it('closes the stream when the account has been locked since connecting', async () => {
    const { users, tokens, permissions } = makeDeps();
    users.authStateOf.mockResolvedValue({
      isLocked: true,
      isActive: true,
      isInvited: false,
    });

    await expect(
      firstValueFrom(
        sseHeartbeat$(
          1,
          users as never,
          tokens as never,
          permissions as never,
          baseUser,
        ),
      ),
    ).rejects.toThrow('Tài khoản không còn hoạt động.');
  });

  it('closes the stream when the account has been deactivated (and never invited)', async () => {
    const { users, tokens, permissions } = makeDeps();
    users.authStateOf.mockResolvedValue({
      isLocked: false,
      isActive: false,
      isInvited: false,
    });

    await expect(
      firstValueFrom(
        sseHeartbeat$(
          1,
          users as never,
          tokens as never,
          permissions as never,
          baseUser,
        ),
      ),
    ).rejects.toThrow('Tài khoản không còn hoạt động.');
  });

  it('closes the stream when a session token has been logged out mid-connection', async () => {
    const { users, tokens, permissions } = makeDeps();
    const withSid = { ...baseUser, sid: 'session-1' };
    tokens.sessionActive.mockResolvedValue(false);

    await expect(
      firstValueFrom(
        sseHeartbeat$(
          1,
          users as never,
          tokens as never,
          permissions as never,
          withSid,
        ),
      ),
    ).rejects.toThrow('Phiên đã đăng xuất — vui lòng đăng nhập lại.');
    expect(tokens.sessionActive).toHaveBeenCalledWith('session-1');
  });

  it('does not check session activity when the connection has no sid (a permanent token)', async () => {
    const { users, tokens, permissions } = makeDeps();

    await firstValueFrom(
      sseHeartbeat$(
        1,
        users as never,
        tokens as never,
        permissions as never,
        baseUser,
      ),
    );

    expect(tokens.sessionActive).not.toHaveBeenCalled();
  });

  it('closes the stream when a permanent token (jti) has been revoked mid-connection', async () => {
    const { users, tokens, permissions } = makeDeps();
    const withJti = { ...baseUser, jti: 'jti-1' };
    permissions.resolveApiToken.mockResolvedValue(null);

    await expect(
      firstValueFrom(
        sseHeartbeat$(
          1,
          users as never,
          tokens as never,
          permissions as never,
          withJti,
        ),
      ),
    ).rejects.toThrow('Token đã bị thu hồi.');
    expect(permissions.resolveApiToken).toHaveBeenCalledWith('jti-1');
  });

  it('closes the stream when a jti resolves to a different owner than the connection claims', async () => {
    const { users, tokens, permissions } = makeDeps();
    const withJti = { ...baseUser, jti: 'jti-1' };
    permissions.resolveApiToken.mockResolvedValue('someone-else');

    await expect(
      firstValueFrom(
        sseHeartbeat$(
          1,
          users as never,
          tokens as never,
          permissions as never,
          withJti,
        ),
      ),
    ).rejects.toThrow('Token đã bị thu hồi.');
  });

  it('does not check jti when the connection has none (a normal session token)', async () => {
    const { users, tokens, permissions } = makeDeps();

    await firstValueFrom(
      sseHeartbeat$(
        1,
        users as never,
        tokens as never,
        permissions as never,
        baseUser,
      ),
    );

    expect(permissions.resolveApiToken).not.toHaveBeenCalled();
  });

  it('re-checks on every tick, not just the first, so a mid-connection revoke is caught within one interval', async () => {
    const { users, tokens, permissions } = makeDeps();

    const emissions = await firstValueFrom(
      sseHeartbeat$(
        5,
        users as never,
        tokens as never,
        permissions as never,
        baseUser,
      ).pipe(take(3), toArray()),
    );

    expect(emissions).toHaveLength(3);
    expect(users.authStateOf).toHaveBeenCalledTimes(3);
  });
});
