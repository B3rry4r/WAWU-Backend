import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from '../../../../generated/prisma/enums';

export const ADMIN_ROLES_KEY = 'adminRoles';

/**
 * `@AdminRoles('superadmin', 'finance')` — declares which admin roles may
 * reach a handler. Read by AdminRolesGuard (../guards/admin-roles.guard.ts),
 * which must be listed AFTER AdminAuthGuard in the same `@UseGuards(...)`.
 *
 * No role-metadata idiom existed in this codebase before this module, because
 * no role existed: every "admin" gate shipped so far is an env-var allowlist
 * of WAWU user ids (src/kyc-submission/guards/admin.guard.ts,
 * src/verification-submission/guards/admin.guard.ts) with no role dimension
 * at all. Those guards are untouched. This is the standard Nest
 * SetMetadata + Reflector pattern rather than an invented one, so a handler's
 * role requirement is readable at the handler.
 */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);
