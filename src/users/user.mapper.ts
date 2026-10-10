import { UserEntity } from './entities/user.entity';

/** A role key slug (`admin`, `operator`, `viewer`, or a custom one). */
export type FeRole = string;
export type UserStatus = 'active' | 'locked' | 'invited' | 'inactive';

export interface AccountUserDto {
  name: string;
  username: string;
  email: string;
  phone: string;
  shift: string;
  role: FeRole;
  roleName: string;
  photo: string | null;
  created: string;
  mustChangePassword: boolean;
}

export interface AdminUserDto {
  id: string;
  name: string;
  username: string;
  email: string;
  role: FeRole;
  roleName: string;
  status: UserStatus;
  phone: string;
  shift: string;
  online: boolean;
  lastActive: string | null;
  created: string;
  lockReason: string | null;
  mustChangePassword: boolean;
}

export function deriveStatus(u: UserEntity): UserStatus {
  if (u.isLocked) return 'locked';
  if (u.isInvited) return 'invited';
  if (u.isActive) return 'active';
  return 'inactive';
}

export function toAccountUser(
  u: UserEntity,
  role: FeRole,
  roleName: string,
): AccountUserDto {
  return {
    name: u.fullName,
    username: u.username,
    email: u.email,
    phone: u.phone ?? '',
    shift: u.shift ?? '',
    role,
    roleName,
    photo: u.avatarUrl,
    created: u.createdAt.toISOString(),
    mustChangePassword: u.mustChangePassword,
  };
}

export function toAdminUser(
  u: UserEntity,
  role: FeRole,
  roleName: string,
  online: boolean,
): AdminUserDto {
  return {
    id: u.id,
    name: u.fullName,
    username: u.username,
    email: u.email,
    role,
    roleName,
    status: deriveStatus(u),
    phone: u.phone ?? '',
    shift: u.shift ?? '',
    online,
    lastActive: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    created: u.createdAt.toISOString(),
    lockReason: u.lockReason ?? null,
    mustChangePassword: u.mustChangePassword,
  };
}
