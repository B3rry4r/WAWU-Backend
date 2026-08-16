import { Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { FollowRelationshipService } from './follow-relationship.service';

/**
 * registry.json "FollowRelationship": POST/DELETE /creators/:wawuId/follow.
 * Both endpoints are `roles: ["any"]` — any authenticated WAWU user, no
 * creator gate. `:wawuId` is the target creator being followed/unfollowed
 * (the WAWU ID `sub` value), never a local FK.
 */
@UseGuards(WawuAuthGuard)
@Controller('creators/:wawuId/follow')
export class FollowRelationshipController {
  constructor(private readonly followRelationshipService: FollowRelationshipService) {}

  @Post()
  follow(
    @Param('wawuId') wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<{ following: true }> {
    return this.followRelationshipService.follow(user.sub, wawuId);
  }

  @Delete()
  unfollow(
    @Param('wawuId') wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<{ following: false }> {
    return this.followRelationshipService.unfollow(user.sub, wawuId);
  }
}
