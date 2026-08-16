import { Module } from '@nestjs/common';
import { CreatorSubscriptionController } from './creator-subscription.controller';
import { CreatorSubscriptionService } from './creator-subscription.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';

/**
 * registry.json "CreatorSubscription" resource module. PrismaService comes
 * from the globally-registered PrismaModule (conventions.md § ORM /
 * database) — not re-imported here.
 *
 * FlutterwaveClient DI-token swap (conventions.md § Local test environment,
 * task brief): real Flutterwave test-mode credentials are not available in
 * this sandbox, so this backend wires the deterministic MockFlutterwaveAdapter
 * whenever `FLUTTERWAVE_SECRET_KEY` is absent or `NODE_ENV=test`, and only
 * reaches for RealFlutterwaveAdapter when a secret key is actually configured
 * outside tests. Resolved via a `useFactory` (evaluated when Nest
 * instantiates the provider graph, i.e. after ConfigModule has loaded
 * `.env`) rather than a module-load-time constant, mirroring
 * src/purchase/purchase.module.ts's precedent exactly. Callers everywhere
 * else inject the `FLUTTERWAVE_CLIENT` token, never either adapter directly.
 */
@Module({
  controllers: [CreatorSubscriptionController],
  providers: [
    CreatorSubscriptionService,
    CreatorAccountGuard,
    RealFlutterwaveAdapter,
    MockFlutterwaveAdapter,
    {
      provide: FLUTTERWAVE_CLIENT,
      useFactory: (
        mock: MockFlutterwaveAdapter,
        real: RealFlutterwaveAdapter,
      ) =>
        process.env.NODE_ENV === 'test' || !process.env.FLUTTERWAVE_SECRET_KEY
          ? mock
          : real,
      inject: [MockFlutterwaveAdapter, RealFlutterwaveAdapter],
    },
  ],
})
export class CreatorSubscriptionModule {}
