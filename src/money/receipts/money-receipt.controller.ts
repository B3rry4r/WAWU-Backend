import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import { RECEIPT_RENDER_THROTTLE } from './receipt-config';
import {
  RECEIPT_BUSY_MESSAGE,
  RECEIPT_BUSY_RETRY_SECONDS,
  ReceiptBusyError,
} from './receipt-draw-limiter';
import type { ReceiptView } from './receipt-view.type';
import { ReceiptService } from './receipt.service';

/**
 * A transaction's receipt for its owner (task WALLET-18): the short code
 * anyone can check at wawu/r/<code>, and the receipt drawn as an image
 * (W42) or a one-page A4 PDF (W43), for W41's "Share receipt as".
 *
 * Behind the wallet gate (MONEY-13) like every wallet route, and only for a
 * row on the caller's own wallet: someone else's is the same `404
 * not_found` as no row (MONEY-15's detail). Each route makes the code the
 * first time and answers the same code after. Nothing here calls Fintava
 * or moves money. The image and the PDF are drawn on each request, so they
 * are throttled tighter than the app's default (RECEIPT_RENDER_THROTTLE),
 * and at most RECEIPT_RENDER_CONCURRENCY draw at once in the process; a
 * request that finds no slot in 10 s is answered 503 with Retry-After.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyReceiptController {
  constructor(private readonly receipts: ReceiptService) {}

  /** W41: the receipt and its code. The same code every time. */
  @Post('transactions/:id/receipt')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-18')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  issue(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReceiptView> {
    return this.receipts.issue(wallet, id);
  }

  /** W42: the receipt as a PNG, always a white document. */
  @Get('transactions/:id/receipt/image')
  @Throttle(RECEIPT_RENDER_THROTTLE)
  @BuiltBy('WALLET-18')
  @RequireOpenWallet()
  @ApiOkResponse({
    description: 'The receipt as a PNG image.',
    content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
  })
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  @ApiResponse({ status: 503, description: RECEIPT_BUSY_MESSAGE })
  async image(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { body, code } = await busy(res, this.receipts.image(wallet, id));
    send(res, body, 'image/png', `Receipt-${code}.png`);
  }

  /** W43: the receipt as a one-page A4 PDF. */
  @Get('transactions/:id/receipt/pdf')
  @Throttle(RECEIPT_RENDER_THROTTLE)
  @BuiltBy('WALLET-18')
  @RequireOpenWallet()
  @ApiOkResponse({
    description: 'The receipt as a one-page A4 PDF.',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  @ApiResponse({ status: 503, description: RECEIPT_BUSY_MESSAGE })
  async pdf(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { body, code } = await busy(res, this.receipts.pdf(wallet, id));
    send(res, body, 'application/pdf', `Receipt-${code}.pdf`);
  }
}

/** Every drawing slot stayed busy (DrawLimiter): the 503 also says when to try again. */
async function busy<T>(res: Response, drawing: Promise<T>): Promise<T> {
  try {
    return await drawing;
  } catch (e) {
    if (e instanceof ReceiptBusyError)
      res.set('Retry-After', String(RECEIPT_BUSY_RETRY_SECONDS));
    throw e;
  }
}

function send(res: Response, body: Buffer, type: string, filename: string) {
  res
    .status(200)
    .set({
      'Content-Type': type,
      'Content-Length': String(body.length),
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    })
    .end(body);
}
