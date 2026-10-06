import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { FeeQuoteQueryDto } from '../dto/money-request.dto';
import {
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { FeeQuoteView } from '../money-view.type';
import { FeeQuoteService } from './fee-quote.service';

/**
 * The fee quote (task WALLET-15). Declared by MONEY-04, served here
 * (docs/contract/CONVENTIONS.md section 0).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyFeesController {
  constructor(private readonly quotes: FeeQuoteService) {}

  /**
   * What a send, a withdrawal, a purchase or a bill will cost, before the
   * PIN (W10, W17, H14): Fintava's charge plus WAWU's fee from config
   * (R-10, R-31), each charge as its own part, the total, and a signed
   * quote the paying request can send back. Nothing is reserved and
   * Fintava is not asked. A purchase or bill whose total is above
   * MERCHANT_MAX_PER_TXN_KOBO is amount_out_of_range with maximumKobo.
   */
  @Get('fees/quote')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-15')
  @RequireOpenWallet()
  @MoneyErrors(...WALLET_GATE_ERRORS, 'amount_out_of_range')
  feeQuote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: FeeQuoteQueryDto,
  ): FeeQuoteView {
    if (query.kind !== 'bill' && query.billCategory !== undefined) {
      throw new BadRequestException([
        'billCategory is only sent with kind bill.',
      ]);
    }
    return this.quotes.quote(wallet.wawuUserId, {
      kind: query.kind,
      amountKobo: query.amountKobo,
      billCategory: query.billCategory ?? null,
    });
  }
}
