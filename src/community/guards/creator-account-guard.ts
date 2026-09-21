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
 * "creator" role gate for POST /communities and PATCH /communities/:id.
 * Hosting a community is a creator-account capability — the browse/join
 * endpoints on this controller stay `roles: ["any"]` and are NOT gated by
 * this guard.
 *
 * Account type (`user` | `creator`) lives in this backend's own UserProfile
 * table, never on the WAWU ID JWT (conventions.md § Roles & permissions).
 * Deliberately local to this resource's directory, mirroring
 * src/content-piece/guards/creator-account-guard.ts's established pattern
 * (one copy per resource dir) rather than importing another resource's copy
 * or hoisting a shared one into src/common.
 *
 * This guard checks ACCOUNT TYPE, and that is now the whole gate on hosting.
 * CommunityService.create used to add two entitlement checks on top of it
 * (CreatorState.subscriptionPaid for hosting at all, CreatorState.tier for
 * private communities); both were subscription entitlements and went with
 * subscriptions.
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
