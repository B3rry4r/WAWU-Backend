import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { UserProfileController } from './user-profile.controller';
import { PublicUserProfileController } from './public-user-profile.controller';
import { UserProfileService } from './user-profile.service';

/**
 * registry.json "UserProfile" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here.
 */
@Module({
  // WawuAuthModule for WawuIdClient: a user's NAME lives in WAWU ID, not
  // here, so editing it on this screen is proxied there.
  imports: [WawuAuthModule],
  controllers: [UserProfileController, PublicUserProfileController],
  providers: [UserProfileService],
})
export class UserProfileModule {}
