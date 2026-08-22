import { Module } from '@nestjs/common';
import { ServiceApplicationController } from './service-application.controller';
import { ServiceApplicationAliasController } from './service-application-alias.controller';
import { ServiceApplicationOpsController } from './service-application-ops.controller';
import { ServiceApplicationService } from './service-application.service';
import { FLUTTERWAVE_CLIENT } from './flutterwave-client.interface';
import { MockFlutterwaveAdapter } from './mock-flutterwave.adapter';
import { RealFlutterwaveAdapter } from './real-flutterwave.adapter';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';

/**
 * registry.json "ServiceApplication" resource module. PrismaService comes
 * from the globally-registered PrismaModule (conventions.md § ORM /
 * database) — not re-imported here.
 *
 * FLUTTERWAVE_CLIENT is DI-token-swapped (conventions.md § Local test
 * environment): real Flutterwave test-mode keys aren't available in this
 * sandbox, so whenever FLUTTERWAVE_SECRET_KEY is unset or still the
 * `.env`-committed placeholder, MockFlutterwaveAdapter is wired in instead
 * of RealFlutterwaveAdapter — this is what every contract test run in this
 * sandbox exercises. Set a real secret key (or FLUTTERWAVE_MODE=live) to
 * switch to the real adapter in an environment that has one.
 */
function usesMockFlutterwave(): boolean {
  if (process.env.FLUTTERWAVE_MODE === 'mock') return true;
  if (process.env.FLUTTERWAVE_MODE === 'live') return false;
  // Shared guard: refuses to boot in production rather than silently
  // substituting an adapter that approves every charge for free.
  return shouldUseMockFlutterwave();
}

@Module({
  controllers: [
    ServiceApplicationController,
    ServiceApplicationAliasController,
    ServiceApplicationOpsController,
  ],
  providers: [
    ServiceApplicationService,
    {
      provide: FLUTTERWAVE_CLIENT,
      useClass: usesMockFlutterwave() ? MockFlutterwaveAdapter : RealFlutterwaveAdapter,
    },
  ],
  // Exported for PaymentWebhookModule (provider-driven CAC settlement).
  exports: [ServiceApplicationService],
})
export class ServiceApplicationModule {}
