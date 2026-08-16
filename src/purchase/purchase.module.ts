import { Module } from '@nestjs/common';
import { PurchaseController } from './purchase.controller';
import { PurchaseService } from './purchase.service';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';

/**
 * registry.json "Purchase" resource module. PrismaService comes from the
 * globally-registered PrismaModule (conventions.md § ORM / database) — not
 * re-imported here.
 *
 * FlutterwaveClient DI-token swap (conventions.md § Local test environment,
 * task brief): real Flutterwave test-mode credentials are not available in
 * this sandbox, so this backend wires the deterministic MockFlutterwaveAdapter
 * whenever `FLUTTERWAVE_SECRET_KEY` is absent or `NODE_ENV=test`, and only
 * reaches for RealFlutterwaveAdapter when a secret key is actually configured
 * outside tests. Resolved via a `useFactory` (evaluated when Nest
 * instantiates the provider graph, i.e. after ConfigModule has loaded
 * `.env`) rather than a module-load-time constant, so it never races
 * dotenv — a top-level `process.env` read here would run before
 * ConfigModule.forRoot() ever fires (import statements execute before the
 * importing file's own `@Module()` decorator body). Callers everywhere else
 * inject the `FLUTTERWAVE_CLIENT` token, never either adapter directly.
 */
@Module({
  controllers: [PurchaseController],
  providers: [
    PurchaseService,
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
export class PurchaseModule {}
