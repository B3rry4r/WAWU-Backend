import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';

/**
 * registry.json VerificationSubmission's `POST /verification/submissions/:id/review`
 * is `roles: ["admin"]`. Documented gap: neither WAWU ID's JWT claims
 * (conventions.md § Auth model) nor this backend's own tables
 * (conventions.md § Roles & permissions: only `user`|`creator` exist) carry
 * any admin concept in wave 0 — no admin identity system exists anywhere in
 * this build yet.
 *
 * Interim, honest gate for this resource only: an env-var allowlist of
 * wawuUserIds (`ADMIN_WAWU_USER_IDS`, comma-separated), checked against the
 * already-verified JWT `sub` claim (WawuAuthGuard runs first). This mirrors
 * the same "trust an out-of-band operator secret" shape already used for
 * WAWU ID's own `X-Service-Key` internal calls, and is scoped entirely to
 * this resource's own directory per the build task's scope rule — a real,
 * shared admin-role system (its own table, its own guard in src/common/) is
 * a cross-cutting decision for a later wave, not this agent's to make
 * unilaterally by reaching into src/common/ or prisma/schema.prisma.
 */
@Injectable()
export class VerificationAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: WawuJwtClaims }>();
    const allowlist = (this.config.get<string>('ADMIN_WAWU_USER_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (!request.user || !allowlist.includes(request.user.sub)) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
