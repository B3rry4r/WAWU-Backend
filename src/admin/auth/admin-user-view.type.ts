// Prisma 7 exports model types with a `Model` suffix; aliased so this file
// reads as the entity it is about (same barrel every src/common/types/*.type.ts uses).
import type { AdminUserModel as AdminUser } from '../../../generated/prisma/models';

/**
 * The ONLY wire shape an AdminUser is ever rendered as.
 *
 * Every other wire type in this codebase is a bare re-export of its Prisma
 * model (src/common/types/*.type.ts — protected-surface hazard H-1). That
 * pattern is not followed here, on purpose: `passwordHash` and
 * `tokenVersion` are on the model and must never reach a response, and a
 * re-export would put them there the moment a service returned a row by
 * spread — which is exactly how the rest of this backend returns rows.
 *
 * Admin-only shape, per the pipeline's "admin gets its own view DTO" rule.
 * No existing app-facing DTO is widened or reused.
 */
export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  role: AdminUser['role'];
  status: AdminUser['status'];
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toAdminUserView(admin: AdminUser): AdminUserView {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    status: admin.status,
    lastLoginAt: admin.lastLoginAt,
    createdAt: admin.createdAt,
  };
}
