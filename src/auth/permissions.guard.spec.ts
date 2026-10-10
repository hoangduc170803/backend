import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './guards/permissions.guard';
import { REQUIRE_PERMISSIONS_KEY } from './decorators/require-permissions.decorator';

function ctx(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function guardWith(required: string[] | undefined): PermissionsGuard {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === REQUIRE_PERMISSIONS_KEY ? required : undefined,
  } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

describe('PermissionsGuard', () => {
  it('allows any request when the route declares no permissions', () => {
    expect(guardWith(undefined).canActivate(ctx({ perms: [] }))).toBe(true);
  });

  it('allows when the user holds every required permission', () => {
    const guard = guardWith(['area.create']);
    expect(guard.canActivate(ctx({ perms: ['area.create', 'map.view'] }))).toBe(
      true,
    );
  });

  it('denies when a required permission is missing', () => {
    const guard = guardWith(['area.delete']);
    expect(() => guard.canActivate(ctx({ perms: ['area.create'] }))).toThrow(
      ForbiddenException,
    );
  });

  it('denies an unauthenticated request', () => {
    const guard = guardWith(['map.view']);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
