import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';

/**
 * "creator" role gate for this resource's single endpoint. The account type
 * (`user` | `creator`) lives in THIS backend's own UserProfile table, never
 * on the WAWU ID JWT (conventions.md § Roles & permissions) — this is
 * distinct from the CreatorState earning gate (kycStatus), which governs
 * whether a creator can be paid, not the account-type role itself.
 * Deliberately local to this resource's directory per the task brief's
 * scope rule (creator-gate logic lives in src/common/ only when a
 * schema/pre-step agent owns it; this build agent owns only its own
 * directory).
 */
@Injectable()
export class CreatorAccountGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user: WawuJwtClaims }>();
    const wawuUserId = request.user?.sub;

    const profile = wawuUserId
      ? await this.prisma.userProfile.findUnique({ where: { wawuUserId } })
      : null;

    if (!profile || profile.accountType !== 'creator') {
      throw new ForbiddenException('This endpoint is only available to creator accounts.');
    }

    return true;
  }
}
