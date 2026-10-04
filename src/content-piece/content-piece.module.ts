import { Module } from '@nestjs/common';
import { ContentPieceController } from './content-piece.controller';
import { PublicContentController } from './public-content.controller';
import {
  ContentEngagementController,
  FeedController,
} from './content-engagement.controller';
import { ContentEngagementService } from './content-engagement.service';
import { ContentPieceService } from './content-piece.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { NotificationModule } from '../notification/notification.module';
import { StorageModule } from '../storage/storage.module';

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
  imports: [NotificationModule, StorageModule, BlockedAccountModule],
  controllers: [
    ContentPieceController,
    PublicContentController,
    ContentEngagementController,
    FeedController,
  ],
  providers: [
    ContentPieceService,
    ContentEngagementService,
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
  exports: [ContentPieceService, FLUTTERWAVE_CLIENT],
})
export class ContentPieceModule {}
