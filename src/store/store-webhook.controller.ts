import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StoreNotificationService } from './store-notification.service';
import type { StoreWebhookAck } from './store-view.type';

/**
 * The stores' own notifications (task IAP-01): `POST /api/hub/webhooks/google-play`
 * (a Pub/Sub push) and `POST /api/hub/webhooks/app-store` (App Store Server
 * Notifications V2), beside the Flutterwave, Fintava and Nuvion ones, which are
 * unchanged. Called by Google and Apple, never by an app: tagged `PaymentWebhook`,
 * which the mobile repo's `contract/mobile-exclusions.json` leaves out of the
 * app's client.
 *
 * Neither takes a user token. Google's push is accepted only with a token Google
 * signed for this endpoint as the subscription's service account; Apple's only
 * when its signed payload verifies against Apple's roots. The global per-address
 * limits apply (a refused push is retried by the sender).
 *
 * Status codes are the retry contract:
 *   200: read (the body says what the Hub did, including `duplicate`, `ignored`
 *        and `unknown`). Do not resend.
 *   400: not a notification. 401: the token or the signature is not valid.
 *   503: the store is not set up here, or could not be reached to check what the
 *        notification says. Please resend.
 */
@ApiTags('PaymentWebhook')
@Controller('webhooks')
export class StoreWebhookController {
  constructor(private readonly notifications: StoreNotificationService) {}

  /** Google Play's real-time developer notifications, pushed by Pub/Sub. The body is Pub/Sub's envelope; the bearer token is checked first. */
  @Post('google-play')
  @HttpCode(200)
  googlePlay(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<StoreWebhookAck> {
    return this.notifications.handleGoogle(authorization, body);
  }

  /** App Store Server Notifications V2: `{ signedPayload }`, a JWS Apple signed. */
  @Post('app-store')
  @HttpCode(200)
  appStore(@Body() body: unknown): Promise<StoreWebhookAck> {
    return this.notifications.handleApple(body);
  }
}
