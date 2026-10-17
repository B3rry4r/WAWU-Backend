import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { StorageModule } from '../storage/storage.module';
import { TierBadgeModule } from '../plans/tier-badge/tier-badge.module';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';

@Module({
  // TierBadgeModule: the tier badge on the cards (TIER-07), a leaf with no routes.
  imports: [
    WawuAuthModule,
    BlockedAccountModule,
    StorageModule,
    TierBadgeModule,
  ],
  controllers: [ExploreController],
  providers: [ExploreService],
})
export class ExploreModule {}
