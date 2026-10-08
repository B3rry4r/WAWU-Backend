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
import { SKIP_EVERY_HUB_THROTTLER } from '../../hub-throttlers';
import {
  NUVION_EVENT_ID_HEADER,
  NUVION_TIMESTAMP_HEADER,
} from './nuvion-signature';
import { NuvionSignatureGuard } from './nuvion-signature.guard';
import { NuvionWebhookStore } from './nuvion-webhook.service';
import type { NuvionWebhookAck } from './nuvion-webhook-view.type';

/**
 * `POST /api/hub/webhooks/nuvion` (task NUV-01): the URL NUV-10 registers
 * with Nuvion (`POST /entity-webhooks`, `https://<host>/api/hub/webhooks/nuvion`),
 * beside the Fintava and Flutterwave ones, which are unchanged. Mounted
 * under every WALLET_PROVIDER: after a rollback, Nuvion's deliveries are
 * still stored for the money Nuvion holds.
 *
 * Called by Nuvion, never by an app: tagged `PaymentWebhook`, which the
 * mobile repo's `contract/mobile-exclusions.json` leaves out of the app's
 * client. No token; NuvionSignatureGuard is the only credential.
 *
 * Rate limits as the Fintava receiver's (OPS-11): every named throttler is
 * skipped (SKIP_EVERY_HUB_THROTTLER), because Nuvion retries a refused
 * delivery for only 15 minutes and a 429 would lose it. Every request is
 * still bounded by the signature check and one insert.
 *
 * Status codes are the retry contract:
 *   200: stored, or a duplicate of one already stored. Do not resend.
 *   400: no JSON body. 401: a signing header missing, a timestamp outside
 *        the window, a wrong signature, or no secret set. Never stored.
 *   503: the database could not take it. Please resend.
 */
@SkipThrottle(SKIP_EVERY_HUB_THROTTLER)
@ApiTags('PaymentWebhook')
@Controller('webhooks/nuvion')
export class NuvionWebhookController {
  constructor(private readonly store: NuvionWebhookStore) {}

  /**
   * Stores one Nuvion delivery and acknowledges it. Nuvion's webhook, never
   * called by an app. The body is untyped on purpose: the global
   * ValidationPipe forbids unknown fields, and Nuvion's payloads differ by
   * event. The signature is checked over the raw bytes before this runs.
   */
  @UseGuards(NuvionSignatureGuard)
  @Post()
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): Promise<NuvionWebhookAck> {
    // The guard has already refused a request without these.
    return this.store.record({
      eventId: request.header(NUVION_EVENT_ID_HEADER) as string,
      signedAt: request.header(NUVION_TIMESTAMP_HEADER) as string,
      rawBody: request.rawBody as Buffer,
      body,
    });
  }
}
