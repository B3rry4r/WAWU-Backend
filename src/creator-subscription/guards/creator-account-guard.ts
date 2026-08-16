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
 * "creator" role gate for every CreatorSubscription endpoint except
 * POST /creator-subscription and POST /creator-subscription/verify (both
 * `roles: ["any"]` per the task brief — the first-time-subscribe path,
 * where the caller isn't a creator account yet). Account type
 * (`user` | `creator`) lives in this backend's own UserProfile table, never
 * on the WAWU ID JWT (conventions.md § Roles & permissions). Deliberately
 * local to this resource's directory (task brief § SCOPE), mirroring
 * src/content-piece/guards/creator-account-guard.ts's established pattern
 * rather than importing it.
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
