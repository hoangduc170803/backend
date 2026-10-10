import type { AuthUser } from './jwt-payload';

export function cancelPermissionsOf(user: Pick<AuthUser, 'perms'>): {
  cargo: boolean;
  direct: boolean;
} {
  return {
    cargo: user.perms.includes('cargo.cancel'),
    direct: user.perms.includes('task.cancel'),
  };
}
