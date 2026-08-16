import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';

/**
 * "creator" role gate for GET /dm/inbox and POST /dm/:messageId/respond.
 * Account type (`user` | `creator`) lives in this backend's own UserProfile
 * table, never on the WAWU ID JWT (conventions.md § Roles & permissions).
 * Deliberately local to this resource's directory (task brief § SCOPE),
 * mirroring src/creator-subscription/guards/creator-account-guard.ts and
 * src/content-piece/guards/creator-account-guard.ts's established pattern
 * rather than importing either.
 *
 * This only gates "is a creator account" — it does NOT check that the
 * caller is the specific creator a given DM was sent to. That ownership
 * check is a separate, per-row concern the brief calls out explicitly for
 * POST /respond and is done in DirectMessageService, not here (CLAUDE.md:
 * "one branch per flow" — account-type gate and row-ownership gate are two
 * different questions with two different failure reasons).
 */
@Injectable()
export class CreatorAccountGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user: WawuJwtClaims }>();
    const wawuUserId = request.user?.sub;

    const profile = wawuUserId
      ? await this.prisma.userProfile.findUnique({ where: { wawuUserId } })
      : null;

    if (!profile || profile.accountType !== 'creator') {
      throw new ForbiddenException(
        'This endpoint is only available to creator accounts.',
      );
    }

    return true;
  }
}
