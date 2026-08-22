import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminTokenService } from '../admin-token.service';
import { toAdminUserView, type AdminUserView } from '../admin-user-view.type';

/**
 * "Any authenticated ADMIN" gate — the admin-side counterpart of
 * WawuAuthGuard (src/common/guards/wawu-auth.guard.ts), sharing nothing with
 * it.
 *
 * Deliberately NOT a passport strategy. WawuAuthGuard is
 * `AuthGuard('wawu-jwt')` and PassportModule is registered process-wide with
 * `defaultStrategy: 'wawu-jwt'` (src/common/auth/wawu-auth.module.ts); adding
 * a second strategy to that registry would be a change to a protected
 * surface. A plain CanActivate reaches the same place without touching it,
 * and matches the idiom every other non-SSO gate in this codebase already
 * uses (AdminKeyGuard, CreatorAccountGuard, KycAdminGuard).
 *
 * Placed in this resource's own guards/ directory rather than src/common/,
 * following the established convention that a guard lives beside the
 * resource that uses it — CreatorAccountGuard is duplicated verbatim into six
 * resource directories rather than hoisted. Admin resources built after this
 * one import it from here; no existing guard is modified or replaced.
 *
 * ── WHY A USER TOKEN CANNOT PASS THIS ────────────────────────────────────
 * Verification goes through AdminTokenService, which pins
 * `algorithms: ['HS256']` against a local secret. A WAWU ID token is RS256
 * signed by a private key this backend has never held, so it fails before
 * any claim is read. That matters more than usual here: the protected
 * registry records that the Hub enforces neither `iss` nor `aud` on user
 * tokens and that passport-jwt checks only signature and expiry, so even a
 * WAWU ID REFRESH token satisfies every user guard. A claim-based separation
 * would therefore be worth nothing — this one is cryptographic.
 *
 * The verified admin is written to `req.admin`, never `req.user`. Nothing
 * this guard does is visible to `@CurrentUser()` or to any existing service
 * that keys on `req.user.sub`.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AdminTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { admin?: AdminUserView }>();

    const header = request.header('authorization');
    const [scheme, token] = header?.split(' ') ?? [];
    if (!token || scheme?.toLowerCase() !== 'bearer') {
      throw new UnauthorizedException('Admin session required.');
    }

    // Throws UnauthorizedException on a bad signature, wrong algorithm,
    // wrong issuer/audience, expiry, or a refresh token presented as access.
    const claims = this.tokens.verifyAccessToken(token);

    const admin = await this.prisma.adminUser.findUnique({ where: { id: claims.sub } });

    // A deleted admin, a suspended admin, and a token whose tokenVersion has
    // been bumped are all one answer: the session is over. tokenVersion is
    // the revocation mechanism — there is no session table, so bumping it
    // invalidates every outstanding access AND refresh token for that admin.
    if (!admin || admin.status !== 'active' || admin.tokenVersion !== claims.tokenVersion) {
      throw new UnauthorizedException('Admin session is invalid or has expired.');
    }

    request.admin = toAdminUserView(admin);
    return true;
  }
}
