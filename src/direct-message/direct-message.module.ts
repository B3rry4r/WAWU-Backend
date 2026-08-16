import { Module } from '@nestjs/common';
import { DirectMessageController } from './direct-message.controller';
import { DirectMessageService } from './direct-message.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';

/**
 * registry.json "DirectMessage" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here.
 *
 * FlutterwaveClient DI-token swap: identical rationale/wiring to
 * src/purchase/purchase.module.ts and
 * src/creator-subscription/creator-subscription.module.ts — real Flutterwave
 * test-mode credentials are not available in this sandbox, so this backend
 * wires the deterministic MockFlutterwaveAdapter whenever
 * `FLUTTERWAVE_SECRET_KEY` is absent or `NODE_ENV=test`, and only reaches
 * for RealFlutterwaveAdapter when a secret key is actually configured
 * outside tests. Resolved via a `useFactory` (evaluated when Nest
 * instantiates the provider graph, i.e. after ConfigModule has loaded
 * `.env`) rather than a module-load-time constant, so it never races
 * dotenv. Callers everywhere else inject the `FLUTTERWAVE_CLIENT` token,
 * never either adapter directly.
 */
@Module({
  controllers: [DirectMessageController],
  providers: [
    DirectMessageService,
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
export class DirectMessageModule {}
