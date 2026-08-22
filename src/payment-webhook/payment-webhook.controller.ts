import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { FlutterwaveSignatureGuard } from './guards/flutterwave-signature.guard';
import { PaymentWebhookService, type WebhookResult } from './payment-webhook.service';

/**
 * `POST /api/hub/webhooks/flutterwave` — the address the Flutterwave
 * dashboard's webhook setting must point at (see README § Deploy checklist).
 *
 * There is no user on this request and no JWT. Its only authentication is
 * FlutterwaveSignatureGuard, which fails closed when FLUTTERWAVE_SECRET_HASH
 * is unset.
 *
 * Throttling is skipped deliberately. Flutterwave retries in bursts, and a
 * 429 here means a paid customer gets nothing — the endpoint is already
 * bounded by the signature guard and by the unique delivery claim.
 *
 * Status codes are the retry contract:
 *   200 — handled (settled, refused, duplicate, unmatched or ignored). Do not
 *         redeliver; the PaymentWebhookReceipt row says what happened.
 *   401 — signature missing/wrong, or webhooks unconfigured. Never processed.
 *   5xx — we could not finish (Flutterwave unreachable, database down).
 *         Please redeliver; the receipt is left reclaimable.
 */
@SkipThrottle()
@Controller('webhooks/flutterwave')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  /**
   * `@Body()` is deliberately untyped. The global ValidationPipe runs with
   * `forbidNonWhitelisted: true`, and Flutterwave's real payload carries
   * dozens of fields (customer, card, meta, app_fee…) that no DTO here
   * models — a DTO would 400 every genuine delivery. The body is narrowed by
   * hand in the service, and none of it is trusted for settlement.
   */
  @UseGuards(FlutterwaveSignatureGuard)
  @Post()
  @HttpCode(200)
  receive(@Body() body: unknown): Promise<WebhookResult> {
    return this.webhooks.handle(body);
  }
}
