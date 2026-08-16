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
 * "creator" role gate for GET /content/mine/earnings (registry.json
 * CreatorEarnings: `roles: ["creator"]`). Account type (`user` | `creator`)
 * lives in this backend's own UserProfile table, never on the WAWU ID JWT
 * (conventions.md § Roles & permissions). Deliberately local to this
 * resource's directory (task brief § SCOPE) rather than importing
 * src/content-piece/guards/creator-account-guard.ts — mirrors that file's
 * own established precedent of a per-resource local copy (see its own doc
 * comment referencing src/creator-no-response-tracker's identical guard).
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
