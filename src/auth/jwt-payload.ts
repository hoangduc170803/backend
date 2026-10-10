export interface JwtPayload {
  sub: string;
  username: string;
  /** The caller's role key (e.g. `admin`, `operator`, `viewer`, or a custom slug). */
  role?: string;
  /** Kept for backwards compatibility with older tokens that still carry this field. */
  roles?: string[];
  /** Present only on permanent (never-expiring) tokens; checked against `api_tokens`. */
  jti?: string;
  /** Standard JWT "issued at" (seconds) — used to reject tokens older than the last password change. */
  iat?: number;
  /** The `user_sessions` row this token belongs to. Absent on permanent tokens, which aren't
   *  tied to a login session. Checked on every request so logout/session-revoke takes effect
   *  immediately instead of waiting for the token to expire naturally. */
  sid?: string | null;
}

export interface AuthUser {
  sub: string;
  username: string;
  role: string;
  roles: string[];
  /** Effective permission keys, resolved from the role at request time. */
  perms: string[];
  /** Map record ids this role is restricted to, resolved at request time; `undefined` = unrestricted. */
  mapIds?: string[];
  jti?: string;
  sid?: string | null;
  mustChangePassword: boolean;
}
