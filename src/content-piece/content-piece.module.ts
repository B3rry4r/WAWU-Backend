import { Module } from '@nestjs/common';
import { ContentPieceController } from './content-piece.controller';
import { PublicContentController } from './public-content.controller';
import {
  ContentEngagementController,
  FeedController,
} from './content-engagement.controller';
import { ContentEngagementService } from './content-engagement.service';
import { ContentDetailController } from './content-detail.controller';
import { ContentDetailService } from './content-detail.service';
import { CourseLessonsController } from './course-lessons.controller';
import { CourseLessonsService } from './course-lessons.service';
import { ContentMediaController } from './content-media.controller';
import { ContentMediaService } from './content-media.service';
import { ProductDraftController } from './product-draft.controller';
import { PreviewCutService } from './preview-cut.service';
import { ProductDraftService } from './product-draft.service';
import { FeedCardsService } from './feed-cards.service';
import { FeedEntriesService } from './feed-entries.service';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { ContentPieceService } from './content-piece.service';
import { CreatorAccountGuard } from '../common/guards/creator-account.guard';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { NotificationModule } from '../notification/notification.module';
import { StorageModule } from '../storage/storage.module';
import { PlansModule } from '../plans/plans.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { PriceListModule } from '../price-list/price-list.module';
import { ContentSaleTermsService } from './content-sale-terms.service';
import { TierBadgeModule } from '../plans/tier-badge/tier-badge.module';

/**
 * registry.json "ContentPiece" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here.
 *
 * FlutterwaveClient DI-token swap mirrors src/purchase/purchase.module.ts's
 * established pattern exactly (task brief: reuse the same approach for
 * ContentPiece's own unlock/verify flow).
 */
@Module({
  imports: [
    NotificationModule,
    StorageModule,
    BlockedAccountModule,
    WawuAuthModule,
    // The publishing gate (TIER-02): publishing needs a tier.
    PlansModule,
    // The tier badge on the creator and professional cards (TIER-07).
    TierBadgeModule,
    // The quick prices and the review time are admin settings (FIX-110).
    PlanSettingsModule,
    // A price a creator sets is on the price list (PRICE-LIST, R-101); also serves GET /prices.
    PriceListModule,
  ],
  controllers: [
    ContentPieceController,
    PublicContentController,
    ContentEngagementController,
    ContentDetailController,
    FeedController,
    ContentMediaController,
    // FIX-107: a course's lessons, one file each (H25).
    CourseLessonsController,
    // Draft products (TIER-02): its own first segment, `product-drafts`.
    ProductDraftController,
  ],
  providers: [
    ContentPieceService,
    ContentSaleTermsService,
    // PREVIEW-AUTO: the preview a piece is published with (a clip, the free file, or a cut made from the full file).
    PreviewCutService,
    ProductDraftService,
    ContentEngagementService,
    ContentDetailService,
    ContentMediaService,
    CourseLessonsService,
    FeedCardsService,
    FeedEntriesService,
    CreatorAccountGuard,
    RealFlutterwaveAdapter,
    MockFlutterwaveAdapter,
    {
      provide: FLUTTERWAVE_CLIENT,
      useFactory: (
        mock: MockFlutterwaveAdapter,
        real: RealFlutterwaveAdapter,
      ) => (shouldUseMockFlutterwave() ? mock : real),
      inject: [MockFlutterwaveAdapter, RealFlutterwaveAdapter],
    },
  ],
  // ContentPieceService is exported for PaymentWebhookModule (provider-driven
  // unlock settlement).
  //
  // FLUTTERWAVE_CLIENT is exported so VerificationModule can take a paid
  // action through the SAME client the content unlock verifies against,
  // rather than adding a sixth hand-copied FlutterwaveClient, adapter pair
  // and DI token to the five the forks gate already reports.
  //
  // FeedCardsService is exported for MeModule (ME-10): its saved, purchase
  // and notification lists show people through the same creatorsFor().
  exports: [ContentPieceService, FLUTTERWAVE_CLIENT, FeedCardsService],
})
export class ContentPieceModule {}
