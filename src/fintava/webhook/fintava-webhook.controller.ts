import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { FintavaSignatureGuard } from './fintava-signature.guard';
import { FintavaWebhookService } from './fintava-webhook.service';
import type { FintavaWebhookAck } from './fintava-webhook-view.type';

/**
 * `POST /api/hub/webhooks/fintava`: the URL OPS-10 registers in Fintava's
 * dashboard (`https://<host>/api/hub/webhooks/fintava`), beside the
 * Flutterwave one, which is unchanged.
 *
 * Called by Fintava, never by an app: tagged `PaymentWebhook`, which the
 * mobile repo's `contract/mobile-exclusions.json` leaves out of the app's
 * client. No token; FintavaSignatureGuard is the only credential.
 *
 * Throttling is skipped, as for Flutterwave: Fintava retries every 3
 * minutes and then hourly, and a 429 would only delay money being
 * recorded. Every request is bounded by the signature check and one insert.
 *
 * Status codes are the retry contract:
 *   200: recorded, or a duplicate of one already recorded. Do not resend.
 *   400: no JSON body. 401: signature missing or wrong, or no secret set.
 *        Never recorded.
 *   503: the database could not take it. Please resend.
 */
@SkipThrottle()
@ApiTags('PaymentWebhook')
@Controller('webhooks/fintava')
export class FintavaWebhookController {
  constructor(private readonly webhooks: FintavaWebhookService) {}

  /**
   * Records one Fintava delivery and acknowledges it. Fintava's webhook,
   * never called by an app. The body is untyped on purpose: the global
   * ValidationPipe forbids unknown fields, and Fintava's payloads differ by
   * event and are not all published, so a DTO would refuse real deliveries.
   * The signature is checked over the raw bytes before this runs.
   */
  @UseGuards(FintavaSignatureGuard)
  @Post()
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): Promise<FintavaWebhookAck> {
    // The guard has already refused a request without these bytes.
    return this.webhooks.record(request.rawBody as Buffer, body);
  }
}
