import { Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBadRequestResponse, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { escapeHtml } from './email-render';
import { verifyUnsubscribeToken } from './email-unsubscribe';

const STYLE = `body{margin:0;background:#0b0b0f;color:#f4f4f6;font-family:Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 12px;line-height:1.3}p{color:#9a9aa6;line-height:1.6;margin:0}
form{margin:22px 0 0}button{background:#9411C9;color:#fff;border:0;border-radius:12px;padding:14px 26px;font-size:16px;font-weight:700;cursor:pointer}`;

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;

/** ada@example.com becomes ad***@example.com. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

export const UNSUBSCRIBED_PAGE = page(
  'You are unsubscribed.',
  '<p>We will not email this address again.</p>',
);
export const BAD_LINK_PAGE = page(
  'This link is not valid',
  '<p>The unsubscribe link is incomplete or has been changed.</p>',
);

/** The page a GET shows: one button that POSTs back to the same signed link. */
export function confirmPage(email: string, token: string): string {
  const action = `/api/hub/email/unsubscribe?t=${encodeURIComponent(token)}`;
  return page(
    `Unsubscribe ${maskEmail(email)} from WAWU emails?`,
    `<p>You will stop getting our emails at this address.</p>` +
      `<form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe</button></form>`,
  );
}

/**
 * The public unsubscribe route (EMAIL-01): `/api/hub/email/unsubscribe?t=...`.
 *
 * GET is the link in the email and changes nothing: mail scanners and link
 * previews open links before the person does, so a GET only shows a plain
 * confirmation page with one button. The button, and the one-click request a
 * mail app sends for the List-Unsubscribe-Post header, are a POST: that adds
 * the address to the suppression list (once; repeating changes nothing) and
 * shows "You are unsubscribed." The token is signed, so nobody can unsubscribe
 * a stranger.
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
    description: 'An HTML page asking to confirm. Nothing is changed.',
  })
  @ApiBadRequestResponse({
    description: 'An HTML page saying the link is not valid.',
  })
  get(@Query('t') token: string | undefined, @Res() res: Response) {
    const email = this.emailOf(token);
    this.headers(res);
    if (!email || !token) {
      res.status(400).send(BAD_LINK_PAGE);
      return;
    }
    res.status(200).send(confirmPage(email, token));
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
  async post(@Query('t') token: string | undefined, @Res() res: Response) {
    const email = this.emailOf(token);
    this.headers(res);
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

  private emailOf(token: string | undefined): string | null {
    return token
      ? verifyUnsubscribeToken(
          token,
          this.config.get<string>('ADMIN_JWT_SECRET'),
        )
      : null;
  }

  private headers(res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
}
