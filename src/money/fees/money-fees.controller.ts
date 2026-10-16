import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Optional,
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
import { MoneyLimits } from '../limits/money-limits.service';
import { FeeQuoteService } from './fee-quote.service';
import { RequireFeesSet } from './fees-set.guard';

/**
 * The fee quote (task WALLET-15). Declared by MONEY-04, served here
 * (docs/contract/CONVENTIONS.md section 0).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyFeesController {
  constructor(
    private readonly quotes: FeeQuoteService,
    // NUV-07: WAWU's limits, where the module that mounts this controller
    // imports MoneyLimitsModule (mobile repo SHARED-CHANGES, NUV-07). With
    // them the quote shows where today's limit stands for this kind; with
    // no daily limit set, or without them, it answers as WALLET-15 did
    // (withinDailyLimit true, remainingTodayKobo null).
    @Optional() private readonly limits?: MoneyLimits,
  ) {}

  /**
   * What a send, a withdrawal, a purchase or a bill will cost, before the
   * PIN (W10, W17, H14): Fintava's charge plus WAWU's fee from config
   * (R-10, R-31), each charge as its own part, the total, and a signed
   * quote the paying request can send back. Nothing is reserved and
   * Fintava is not asked. A purchase or bill whose total is above
   * MERCHANT_MAX_PER_TXN_KOBO is amount_out_of_range with maximumKobo.
   *
   * NUV-07: the provider's charge comes from the running provider's
   * settings. While any of them is unset (Nuvion's, until the owner fills
   * them in) every quote is fees_not_set, before the wallet gate; under
   * Nuvion, which has no bill payments, a bill is target_not_payable.
   */
  @Get('fees/quote')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('WALLET-15')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'amount_out_of_range',
    'fees_not_set',
    'target_not_payable',
  )
  @RequireFeesSet()
  async feeQuote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: FeeQuoteQueryDto,
  ): Promise<FeeQuoteView> {
    if (query.kind !== 'bill' && query.billCategory !== undefined) {
      throw new BadRequestException([
        'billCategory is only sent with kind bill.',
      ]);
    }
    const quote = this.quotes.quote(wallet.wawuUserId, {
      kind: query.kind,
      amountKobo: query.amountKobo,
      billCategory: query.billCategory ?? null,
    });
    if (!this.limits) return quote;
    const standing = await this.limits.dailyStanding({
      wawuUserId: wallet.wawuUserId,
      kind: query.kind,
      amountKobo: query.amountKobo,
    });
    return { ...quote, ...standing };
  }
}
