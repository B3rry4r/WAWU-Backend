import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SKIP_EVERY_HUB_THROTTLER } from '../../../hub-throttlers';
import { EmailEventsService, type EmailEventAck } from './email-events.service';
import { ResendWebhookGuard } from './email-webhook.guard';

/**
 * `POST /api/hub/webhooks/resend` (EMAIL-03): the address the Resend
 * dashboard's webhook points at. No user and no JWT; the Svix signature over
 * the raw body is the only credential (ResendWebhookGuard).
 *
 *   200: stored, or a repeat of one already stored. Do not redeliver.
 *   401: signature or a signing header missing, wrong, or too old. Nothing written.
 *   503: RESEND_WEBHOOK_SECRET is not set here, or the database could not take it.
 *
 * The body is untyped on purpose: the global ValidationPipe forbids unknown
 * fields and Resend's payload differs by event. The raw bytes are on
 * `request.rawBody` (`rawBody: true`, src/hub-app-options.ts), as for the
 * Nuvion and Fintava webhooks.
 */
@SkipThrottle(SKIP_EVERY_HUB_THROTTLER)
@ApiTags('EmailWebhook')
@Controller('webhooks/resend')
export class ResendWebhookController {
  constructor(private readonly events: EmailEventsService) {}

  @UseGuards(ResendWebhookGuard)
  @Post()
  @HttpCode(200)
  receive(
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<EmailEventAck> {
    return this.events.record(request.header('svix-id') as string, body);
  }
}
