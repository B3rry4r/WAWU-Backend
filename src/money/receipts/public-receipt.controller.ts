import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RECEIPT_LOOKUP_THROTTLE } from './receipt-config';
import { RECEIPT_NOT_FOUND_PAGE, receiptPage } from './receipt-page';
import { ReceiptService } from './receipt.service';

/**
 * The public receipt check, wawu/r/<code> (task WALLET-18): anyone with a
 * receipt's code opens this page, signed in or not. It shows only what
 * proves the movement (receipt-page.ts). Any miss, a made-up code, a
 * mistyped one or a receipt whose movement is gone, is the same 404 page,
 * byte for byte, after the same one lookup. Throttled per address
 * (RECEIPT_LOOKUP_THROTTLE), never indexed, never cached, and the page
 * sends no referrer on.
 */
@Controller('r')
export class PublicReceiptController {
  constructor(private readonly receipts: ReceiptService) {}

  @Get(':code')
  @Throttle(RECEIPT_LOOKUP_THROTTLE)
  @ApiOkResponse({
    description:
      'The receipt check page: amount, date, status, both sides masked, reference.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  @ApiNotFoundResponse({
    description: 'No receipt has this code. The same page for every miss.',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  async page(@Param('code') code: string, @Res() res: Response): Promise<void> {
    const receipt = await this.receipts.lookup(code);
    res
      .status(receipt ? 200 : 404)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      })
      .send(receipt ? receiptPage(receipt) : RECEIPT_NOT_FOUND_PAGE);
  }
}
