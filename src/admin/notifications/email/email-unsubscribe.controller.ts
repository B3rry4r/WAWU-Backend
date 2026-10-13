import { Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBadRequestResponse, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { verifyUnsubscribeToken } from './email-unsubscribe';

const page = (title: string, line: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;background:#0b0b0f;color:#f4f4f6;font-family:Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{color:#9a9aa6;line-height:1.6;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${line}</p></main></body></html>`;

export const UNSUBSCRIBED_PAGE = page(
  'You are unsubscribed',
  'We will not email this address again.',
);
export const BAD_LINK_PAGE = page(
  'This link is not valid',
  'The unsubscribe link is incomplete or has been changed.',
);

/**
 * The public unsubscribe route (EMAIL-01): `/api/hub/email/unsubscribe?t=...`.
 * GET is the link in the email; POST is what a mail app sends for the
 * one-click header (List-Unsubscribe-Post). Both add the address to the
 * suppression list (once; repeating changes nothing) and show a plain
 * confirmation. The token is signed, so nobody can unsubscribe a stranger.
 */
@Controller('email')
export class PublicEmailUnsubscribeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get('unsubscribe')
  @Throttle({ medium: { limit: 120, ttl: 10 * 60_000 } })
  @ApiOkResponse({
    description: 'An HTML page confirming the address is unsubscribed.',
  })
  @ApiBadRequestResponse({
    description: 'An HTML page saying the link is not valid.',
  })
  get(@Query('t') token: string | undefined, @Res() res: Response) {
    return this.handle(token, res);
  }

  @Post('unsubscribe')
  @HttpCode(200)
  @Throttle({ medium: { limit: 120, ttl: 10 * 60_000 } })
  @ApiOkResponse({
    description: 'An HTML page confirming the address is unsubscribed.',
  })
  @ApiBadRequestResponse({
    description: 'An HTML page saying the link is not valid.',
  })
  post(@Query('t') token: string | undefined, @Res() res: Response) {
    return this.handle(token, res);
  }

  private async handle(
    token: string | undefined,
    res: Response,
  ): Promise<void> {
    const email = token
      ? verifyUnsubscribeToken(
          token,
          this.config.get<string>('ADMIN_JWT_SECRET'),
        )
      : null;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!email) {
      res.status(400).send(BAD_LINK_PAGE);
      return;
    }
    await this.prisma.emailSuppression.upsert({
      where: { email },
      create: { email, reason: 'unsubscribed' },
      update: {},
    });
    res.status(200).send(UNSUBSCRIBED_PAGE);
  }
}
