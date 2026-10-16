import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { NUVION_CONFIG_KEYS, NUVION_WEBHOOK_WINDOW_MS } from '../nuvion-config';
import {
  NUVION_EVENT_ID,
  NUVION_EVENT_ID_HEADER,
  NUVION_SIGNATURE_HEADER,
  NUVION_TIMESTAMP_HEADER,
  nuvionSignatureMatches,
  readNuvionTimestamp,
  withinNuvionWindow,
} from './nuvion-signature';

/**
 * The only authentication a Nuvion webhook has (task NUV-01): no user, no
 * token. Guards run before the handler, so a refused delivery never reaches
 * the database.
 *
 * Refused with 401, nothing stored: no secret set on this server
 * (NUVION_WEBHOOK_SECRET; fails closed, under any WALLET_PROVIDER), a
 * missing `x-nuvion-event-id`, `x-nuvion-event-timestamp` or
 * `x-nuvion-event-signature`, an event id we would not store, a timestamp
 * that is not a time or is further than NUVION_WEBHOOK_WINDOW_MS from our
 * clock (a replayed capture), or a signature that does not match the
 * HMAC-SHA256 of `{timestamp}.{raw body}`. Refused with 400: no JSON body
 * (the raw bytes exist only for a parsed JSON body, `rawBody: true` in
 * src/hub-app-options.ts).
 *
 * Logs say only why: never a header, the body or the secret.
 */
@Injectable()
export class NuvionSignatureGuard implements CanActivate {
  private readonly logger = new Logger(NuvionSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  /** Our clock; a spec can move it. */
  now(): number {
    return Date.now();
  }

  canActivate(context: ExecutionContext): boolean {
    const refuse = (why: string, message: string) => {
      this.logger.warn(`nuvion webhook refused: ${why}`);
      return new UnauthorizedException(message);
    };
    const secret =
      this.config.get<string>(NUVION_CONFIG_KEYS.webhookSecret)?.trim() ?? '';
    if (secret === '') {
      throw refuse(
        `${NUVION_CONFIG_KEYS.webhookSecret} is not set`,
        'Nuvion webhooks are not configured on this server.',
      );
    }

    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const eventId = request.header(NUVION_EVENT_ID_HEADER);
    const timestamp = request.header(NUVION_TIMESTAMP_HEADER);
    const signature = request.header(NUVION_SIGNATURE_HEADER);
    if (!eventId || !timestamp || !signature) {
      throw refuse(
        'a signing header is missing',
        'Webhook signature required.',
      );
    }
    if (!NUVION_EVENT_ID.test(eventId)) {
      throw refuse(
        'the event id is not one we store',
        'Webhook signature rejected.',
      );
    }

    const raw = request.rawBody;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      this.logger.warn('nuvion webhook refused: no JSON body to check');
      throw new BadRequestException('Webhook body must be JSON.');
    }

    const signedAt = readNuvionTimestamp(timestamp);
    if (
      signedAt === null ||
      !withinNuvionWindow(signedAt, this.now(), NUVION_WEBHOOK_WINDOW_MS)
    ) {
      throw refuse(
        'the timestamp is not within the window',
        'Webhook signature rejected.',
      );
    }
    if (!nuvionSignatureMatches(secret, timestamp, raw, signature)) {
      throw refuse('signature does not match', 'Webhook signature rejected.');
    }
    return true;
  }
}
