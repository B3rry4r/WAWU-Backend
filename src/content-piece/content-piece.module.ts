import { Module } from '@nestjs/common';
import { ContentPieceController } from './content-piece.controller';
import { PublicContentController } from './public-content.controller';
import { ContentPieceService } from './content-piece.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';

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
  controllers: [ContentPieceController, PublicContentController],
  providers: [
    ContentPieceService,
    CreatorAccountGuard,
    RealFlutterwaveAdapter,
    MockFlutterwaveAdapter,
    {
      provide: FLUTTERWAVE_CLIENT,
      useFactory: (
        mock: MockFlutterwaveAdapter,
        real: RealFlutterwaveAdapter,
      ) =>
        shouldUseMockFlutterwave()
          ? mock
          : real,
      inject: [MockFlutterwaveAdapter, RealFlutterwaveAdapter],
    },
  ],
})
export class ContentPieceModule {}
