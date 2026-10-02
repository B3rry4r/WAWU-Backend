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
import { FINTAVA_CONFIG_KEYS } from '../fintava-config';
import {
  FINTAVA_SIGNATURE_HEADER,
  fintavaSignatureMatches,
} from './fintava-signature';

/**
 * The only authentication a Fintava webhook has (task MONEY-07). There is
 * no user and no token on the request.
 *
 * Checks `x-fintava-signature` against the HMAC-SHA512 of the RAW body (the
 * bytes Fintava signed, kept by `rawBody: true` in src/hub-app-options.ts;
 * a re-serialised body would not match). Guards run before the handler, so
 * a refused delivery never reaches the database.
 *
 * Fails closed: with FINTAVA_WEBHOOK_SECRET unset every delivery is refused
 * (401), never accepted unchecked. Fintava retries a refused delivery for
 * 72 hours, so a secret set late loses nothing.
 *
 * Logs say only why a delivery was refused: never the header, the body or
 * the secret.
 */
@Injectable()
export class FintavaSignatureGuard implements CanActivate {
  private readonly logger = new Logger(FintavaSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret =
      this.config.get<string>(FINTAVA_CONFIG_KEYS.webhookSecret)?.trim() ?? '';
    if (secret === '') {
      this.logger.warn(
        `fintava webhook refused: ${FINTAVA_CONFIG_KEYS.webhookSecret} is not set`,
      );
      throw new UnauthorizedException(
        'Fintava webhooks are not configured on this server.',
      );
    }

    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const provided = request.header(FINTAVA_SIGNATURE_HEADER);
    if (!provided) {
      this.logger.warn('fintava webhook refused: no signature');
      throw new UnauthorizedException('Webhook signature required.');
    }

    // The raw bytes exist only for a JSON (or form) body parsed with
    // `rawBody: true`. Anything else cannot be checked, so it is refused.
    const raw = request.rawBody;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      this.logger.warn('fintava webhook refused: no JSON body to check');
      throw new BadRequestException('Webhook body must be JSON.');
    }

    if (!fintavaSignatureMatches(secret, raw, provided)) {
      this.logger.warn('fintava webhook refused: signature does not match');
      throw new UnauthorizedException('Webhook signature rejected.');
    }
    return true;
  }
}
