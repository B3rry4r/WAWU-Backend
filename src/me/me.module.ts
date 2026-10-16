import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { ContentPieceModule } from '../content-piece/content-piece.module';
import { StorageModule } from '../storage/storage.module';
import { PointsModule } from '../points/points.module';
import { MeController } from './me.controller';
import { MeSavedService } from './me-saved.service';
import { MePurchasesService } from './me-purchases.service';
import { MeNotificationsService } from './me-notifications.service';
import { MeEarningsService } from './me-earnings.service';

/**
 * The caller's own lists (task ME-10). ContentPieceModule supplies
 * FeedCardsService, the one place a creator's name, avatar and ticks are put
 * together for a list, so these lists show people exactly as the feed does.
 */
@Module({
  imports: [
    WawuAuthModule,
    BlockedAccountModule,
    ContentPieceModule,
    StorageModule,
    // POINTS-01: GET /me/points and the points expiry job, mounted here so
    // AppModule is not edited (SHARED-CHANGES POINTS-01 #1).
    PointsModule,
  ],
  controllers: [MeController],
  providers: [
    MeSavedService,
    MePurchasesService,
    MeNotificationsService,
    MeEarningsService,
  ],
})
export class MeModule {}
