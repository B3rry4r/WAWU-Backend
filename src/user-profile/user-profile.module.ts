import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { UserProfileController } from './user-profile.controller';
import { PublicUserProfileController } from './public-user-profile.controller';
import { UserProfileService } from './user-profile.service';

/**
 * registry.json "UserProfile" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here.
 */
@Module({
  imports: [
    // WawuAuthModule for WawuIdClient: a user's NAME lives in WAWU ID, not
    // here, so editing it on this screen is proxied there.
    WawuAuthModule,
    // ContentPieceService, for GET /users/:wawuId/content — reused rather
    // than duplicated so a creator's profile and their own /content/mine
    // shelf can never disagree about what "live" or "unlocked" means.
    ContentPieceModule,
  ],
  controllers: [UserProfileController, PublicUserProfileController],
  providers: [UserProfileService],
})
export class UserProfileModule {}
