import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { resendWebhookSecret } from './email-config';
import { checkSvix } from './email-webhook';

/**
 * The only authentication the Resend webhook has (EMAIL-03). Runs before the
 * handler, so a refused request never reaches the database. No secret on this
 * server: 503 (the webhook is not set up, and Resend retries). A missing
 * header, a wrong signature or a timestamp outside five minutes: 401. Logs say
 * only why, never a header, the body or the secret.
 */
@Injectable()
export class ResendWebhookGuard implements CanActivate {
  private readonly logger = new Logger(ResendWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  /** Our clock; a spec can move it. */
  now(): number {
    return Date.now();
  }

  canActivate(context: ExecutionContext): boolean {
    const secret = resendWebhookSecret(this.config);
    if (!secret) {
      this.logger.warn(
        'resend webhook refused: RESEND_WEBHOOK_SECRET is not set',
      );
      throw new ServiceUnavailableException(
        'Email delivery tracking is not set up on this server.',
      );
    }
    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const id = request.header('svix-id');
    const timestamp = request.header('svix-timestamp');
    const signature = request.header('svix-signature');
    if (!id || !timestamp || !signature) {
      this.logger.warn('resend webhook refused: a signing header is missing');
      throw new UnauthorizedException('Webhook signature required.');
    }
    const raw = request.rawBody;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      throw new BadRequestException('Webhook body must be JSON.');
    }
    const verdict = checkSvix({
      secret,
      id,
      timestamp,
      signature,
      rawBody: raw,
      nowMs: this.now(),
    });
    if (verdict !== 'ok') {
      this.logger.warn(`resend webhook refused: ${verdict}`);
      throw new UnauthorizedException('Webhook signature rejected.');
    }
    return true;
  }
}
