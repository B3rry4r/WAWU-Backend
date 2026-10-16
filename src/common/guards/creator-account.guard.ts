import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { WawuJwtClaims } from '../auth/wawu-jwt-claims.interface';

/**
 * "creator" role gate. Account type (`user` | `creator`) lives in this
 * backend's own UserProfile table, never on the WAWU ID JWT (conventions.md
 * § Roles & permissions).
 *
 * One copy for every resource that needs it (GATES-01). It used to be pasted
 * into five resource directories (community, content-piece, creator-earnings,
 * creator-no-response-tracker, direct-message), with the same behaviour in
 * each. That is what the `forks` gate exists to stop: a second copy is a
 * second truth that drifts.
 *
 * This only gates "is a creator account". It does NOT check that the caller is
 * the creator a given row belongs to; that is a per-row concern each service
 * answers on its own, with its own failure reason. Earning is a different
 * question again (the creator's wallet and KYC state), also not asked here.
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
