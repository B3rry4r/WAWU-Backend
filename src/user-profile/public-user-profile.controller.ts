import { Controller, Get, Param } from '@nestjs/common';
import { UserProfileService } from './user-profile.service';

/**
 * Genuinely unauthenticated read for content-list views rendered on the
 * signed-out marketing landing page (getFeaturedContent/mapContentPiece in
 * the frontend — every list endpoint only carries a bare creatorWawuId, no
 * embedded profile, so the card needs a real handle to display instead of
 * the raw internal id). UserProfileController is guarded at the class level
 * with no per-route bypass and every route on it needs a real signed-in
 * caller, including the misleadingly-named "public-profile" one — kept in
 * its own ungated controller rather than weakening that shared guard.
 * getPublicProfile() already only returns already-public-safe fields (no
 * email/phone/private data), so calling it with no requester context is
 * exactly as safe here as it is on the guarded route.
 */
@Controller('users/public')
export class PublicUserProfileController {
  constructor(private readonly userProfileService: UserProfileService) {}

  @Get(':wawuId')
  get(@Param('wawuId') wawuId: string) {
    return this.userProfileService.getPublicProfile(wawuId);
  }
}
