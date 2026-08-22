import type { AdminRole } from '../../../generated/prisma/enums';

/**
 * Shape of a verified WAWU Hub ADMIN token payload.
 *
 * Deliberately NOT `WawuJwtClaims` (src/common/auth/wawu-jwt-claims.interface.ts)
 * and deliberately not compatible with it: `sub` here is an `AdminUser.id`
 * from THIS backend's own table, never a WAWU ID `sub`. The two identity
 * spaces are disjoint and nothing in this file is ever written onto
 * `req.user` — admins land on `req.admin` instead, so no existing guard,
 * service or `@CurrentUser()` call site can ever observe an admin as a user.
 */
export type AdminTokenType = 'admin_access' | 'admin_refresh';

export interface AdminJwtClaims {
  /** AdminUser.id — this backend's own primary key, NOT a WAWU ID sub. */
  sub: string;
  email: string;
  role: AdminRole;
  /** Mirrors AdminUser.tokenVersion; a mismatch revokes the token. */
  tokenVersion: number;
  typ: AdminTokenType;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}
