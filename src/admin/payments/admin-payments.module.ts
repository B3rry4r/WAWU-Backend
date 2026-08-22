import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { PaymentWebhookModule } from '../../payment-webhook/payment-webhook.module';
import { AdminPaymentsController } from './admin-payments.controller';
import { AdminPaymentsService } from './admin-payments.service';

/**
 * Admin payment reconciliation — the read side of `PaymentWebhookReceipt`,
 * which shipped with a writer and no reader.
 *
 * Imports exactly two things:
 *  - AdminAuthModule, for the guards and nothing else. It already exports
 *    AdminAuthGuard and AdminRolesGuard precisely so resource modules built
 *    after it do not re-implement or hoist them.
 *  - PaymentWebhookModule, for `PaymentWebhookService`, which it already
 *    exports (it was exported for the webhook's own tests). This is what makes
 *    re-verify a REUSE of the settlement path rather than a second payment
 *    engine in the admin tree. Its own controller
 *    (`POST /webhooks/flutterwave`) is registered by app.module.ts, not by this
 *    import — Nest registers a controller once per module, and
 *    PaymentWebhookModule is already in the graph.
 *
 * Importing PaymentWebhookModule transitively pulls in every money module,
 * because that is how the webhook reaches each flow's own `/verify`. All of
 * them are already registered in app.module.ts and Nest dedupes, so the
 * load-bearing controller order there (MentorModule / ServiceApplicationModule
 * before PartnerServiceModule's `@Get(':id')` catch-all) is untouched.
 *
 * PrismaService arrives from the global PrismaModule, same as every resource
 * module. Nothing belonging to the app is imported for WRITING, and nothing is
 * modified: the only change made outside this directory was dropping the
 * `private` keyword from `PaymentWebhookService.settle` and `.resolve` so they
 * could be reused instead of copied.
 */
@Module({
  imports: [AdminAuthModule, PaymentWebhookModule],
  controllers: [AdminPaymentsController],
  providers: [AdminPaymentsService],
})
export class AdminPaymentsModule {}
