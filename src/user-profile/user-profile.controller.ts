import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { UserProfileService } from './user-profile.service';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';

/**
 * registry.json "UserProfile": GET/PATCH /users/me (roles: ["any"]) and
 * GET /users/:wawuId/public-profile (roles: ["any"] — public creator view,
 * still requires auth per this backend's own WawuAuthGuard convention since
 * no endpoint in this build is unauthenticated).
 */
@UseGuards(WawuAuthGuard)
@Controller('users')
export class UserProfileController {
  constructor(private readonly userProfileService: UserProfileService) {}

  @Get('me')
  getMe(@CurrentUser() user: WawuJwtClaims) {
    return this.userProfileService.getMe(user);
  }

  @Patch('me')
  upsertMe(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateUserProfileDto,
  ) {
    return this.userProfileService.upsertMe(user.sub, dto);
  }

  @Get(':wawuId/public-profile')
  getPublicProfile(@Param('wawuId') wawuId: string) {
    return this.userProfileService.getPublicProfile(wawuId);
  }
}
