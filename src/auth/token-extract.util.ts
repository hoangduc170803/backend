import type { Request } from 'express';

export function extractBearerLikeToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer '))
    return header.slice('Bearer '.length).trim();

  const cookies = req.cookies as Record<string, string> | undefined;
  if (cookies?.wes_access) return cookies.wes_access;

  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;

  return null;
}

/** A real JWT is header.payload.signature — three base64url segments. */
export function isJwtShaped(token: string): boolean {
  return token.split('.').length === 3;
}
