import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { StorageModule } from '../storage/storage.module';
import { WalletModule } from '../wallet/wallet.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { UserProfileController } from './user-profile.controller';
import { PublicUserProfileController } from './public-user-profile.controller';
import { UserProfileService } from './user-profile.service';
import { ProfileExperienceService } from './profile-experience.service';
import { ProfileDetailsService } from './profile-details.service';
import { ProfileWorksController } from './profile-works.controller';
import { ProfileWorkService } from './profile-work.service';
import { ProfileEducationService } from './profile-education.service';
import { ProfileAudienceService } from './profile-audience.service';

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
    // StorageService, to re-sign avatar and cover URLs on the way out. The
    // stored string is a seven-day presigned read URL, so without this both
    // pictures 403 a week after upload and render as broken images.
    StorageModule,
    // WalletService, to open a creator's wallet the moment this screen is
    // what turns them into one (build brief C7: auto-provision on
    // registration). The wallet module owns every Flutterwave call; nothing
    // here talks to Flutterwave itself.
    WalletModule,
    // BlockedAccountService, so a hidden person's works and education answer
    // 404 like a missing one (ME-16).
    BlockedAccountModule,
  ],
  controllers: [
    UserProfileController,
    ProfileWorksController,
    PublicUserProfileController,
  ],
  providers: [
    UserProfileService,
    ProfileExperienceService,
    ProfileDetailsService,
    ProfileWorkService,
    ProfileEducationService,
    ProfileAudienceService,
  ],
})
export class UserProfileModule {}
