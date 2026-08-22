import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * The only authentication an inbound Flutterwave webhook has.
 *
 * Flutterwave v3 does not sign the body — it echoes back, in the `verif-hash`
 * header, the exact secret hash configured on the merchant dashboard. So the
 * check is a constant-time comparison of that header against
 * `FLUTTERWAVE_SECRET_HASH`, and nothing else about the request is trusted:
 * the payload's amount, status and currency are all re-verified against
 * Flutterwave itself downstream (see PaymentWebhookService).
 *
 * Fails CLOSED, deliberately, and for the same reason as
 * src/common/guards/admin-key.guard.ts: if the secret is unset the endpoint is
 * unreachable rather than open. An unconfigured server must never mean "settle
 * anything anyone posts" — this endpoint grants subscriptions, credits,
 * content unlocks and pays real bills.
 */
@Injectable()
export class FlutterwaveSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.FLUTTERWAVE_SECRET_HASH;
    if (!expected) {
      throw new UnauthorizedException(
        'Payment webhooks are not configured on this server.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('verif-hash');
    if (!provided) {
      throw new UnauthorizedException('Webhook signature required.');
    }

    // Constant time, so a wrong hash cannot be found byte by byte.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Webhook signature rejected.');
    }
    return true;
  }
}
