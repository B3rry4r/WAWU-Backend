import { Module } from '@nestjs/common';
import { CreditPurchaseController } from './credit-purchase.controller';
import { CreditPurchaseService } from './credit-purchase.service';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';

/**
 * registry.json "CreditPurchase" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here.
 *
 * FlutterwaveClient DI-token swap mirrors src/purchase/purchase.module.ts
 * (wave 0) exactly: MockFlutterwaveAdapter whenever `FLUTTERWAVE_SECRET_KEY`
 * is absent or `NODE_ENV=test`, RealFlutterwaveAdapter otherwise. Resolved
 * via `useFactory` (evaluated after ConfigModule has loaded `.env`, not at
 * import time) so it never races dotenv.
 */
@Module({
  controllers: [CreditPurchaseController],
  providers: [
    CreditPurchaseService,
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
  // Exported for PaymentWebhookModule (provider-driven credit settlement).
  exports: [CreditPurchaseService],
})
export class CreditPurchaseModule {}
