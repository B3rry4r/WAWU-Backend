import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';

/**
 * registry.json KycSubmission's `POST /kyc/:id/review` is `roles: ["admin"]`.
 * Same documented gap as verification-submission/guards/admin.guard.ts: no
 * admin identity system exists anywhere in this build yet (neither WAWU
 * ID's JWT claims nor this backend's own `user`|`creator` account types
 * carry an admin concept — conventions.md § Roles & permissions).
 *
 * Interim, honest gate scoped to this resource only (own directory, per the
 * build task's scope rule — not sharing a class with another resource's
 * directory): an env-var allowlist of wawuUserIds (`ADMIN_WAWU_USER_IDS`,
 * comma-separated), checked against the already-verified JWT `sub` claim
 * (WawuAuthGuard runs first). Intentionally the SAME env var name
 * verification-submission's admin guard uses, so one operator-set value
 * grants admin access consistently across both resources rather than
 * inventing a second, differently-named allowlist for the same concept.
 */
@Injectable()
export class KycAdminGuard implements CanActivate {
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
