import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiPaySourceHeader } from './pay-source-context';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { PaymentDto, PaymentQuoteQueryDto } from '../dto/money-request.dto';
import {
  AllowWorldWallet,
  CurrentWallet,
  type OpenWallet,
  RequireOpenWallet,
} from '../gate/wallet-gate';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from '../money-contract';
import type { PaymentQuoteView, PaymentView } from '../money-view.type';
import { RequireFeesSet } from '../fees/fees-set.guard';
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from './idempotency';
import {
  PAY_ROUTE,
  QUOTE_REFUSES_OPEN_KINDS,
  WalletPaymentService,
} from './wallet-payment.service';

/**
 * Pay from wallet (task MONEY-17) and the poll of one payment (task
 * MONEY-19). Declared by MONEY-04, served here (docs/contract/CONVENTIONS.md
 * sections 0 and 14). The holds are MONEY-18's (holds/money-holds.controller.ts).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPaymentsController {
  constructor(private readonly payments: WalletPaymentService) {}

  /**
   * What the pay sheet shows before the PIN (H14, H17): the price from the
   * server's own record of the item, the wallet provider's charge, the
   * total, the balance and the shortfall, and a signed quote the payment
   * sends back. Nothing is reserved. A total above MERCHANT_MAX_PER_TXN_KOBO
   * is amount_out_of_range. A kind whose feature has not moved onto the
   * wallet yet, or an item not priced in naira, is target_not_payable.
   * While the running provider's fees are not set, fees_not_set before
   * anything else (NUV-07); `withinDailyLimit` and `remainingTodayKobo` say
   * where today's purchase limit stands. For a school fee (FIX-58), when the
   * payer already has an open payment for the item (a second phone),
   * `payment_in_progress` with `reason.paymentId`, as the payment itself
   * answers it: no live Pay is drawn. Every other kind is quoted as before.
   *
   * PAY-FX (R-91): with `sourceCurrency` (USD, GBP, EUR ...) the price stays
   * naira and the answer carries `source`: the firm amount the buyer's own
   * account in that currency pays for exactly that naira price, its fees and
   * the provider's real expiry; `quoteToken` is then that quote's, `totalKobo`
   * the naira price and `fee` zero. Absent (or `NGN`) is the naira wallet,
   * exactly as before.
   */
  @Get('payments/quote')
  @ApiPaySourceHeader()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-17')
  @RequireOpenWallet({ world: true })
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'amount_out_of_range',
    'fees_not_set',
    'payment_in_progress',
    'currency_not_supported',
    'fx_account_not_open',
    'rate_unavailable',
    'provider_declined',
    'provider_unreachable',
  )
  @RequireFeesSet()
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: PaymentQuoteQueryDto,
  ): Promise<PaymentQuoteView> {
    return this.payments.quote(wallet, query, {
      refuseIfOpen: QUOTE_REFUSES_OPEN_KINDS.includes(query.kind),
    });
  }

  /**
   * Pay from the wallet: the price from the buyer's wallet to WAWU's own
   * account at the wallet provider (R-19, R-42), the provider's charge on
   * top (R-10), the 85/15 split of the price recorded with it (R-5). Answers
   * 201 with the payment: completed, pending when the provider has not
   * confirmed the debit yet (H18, E10; it is never sent again blindly), or
   * failed when the provider refused it and nothing moved. The same
   * Idempotency-Key and body answer the first result again
   * (`Idempotent-Replayed: true`) without checking the PIN. fees_not_set
   * comes before the wallet gate, the key and the PIN; limit_reached (WAWU's
   * limit or the provider's) before anything is sent.
   *
   * PAY-FX (R-91): with `sourceCurrency` the buyer's account in that currency
   * pays at the firm quote named by `quoteToken`; WAWU converts, the naira
   * lands in its own account and the payee is credited as for a naira
   * payment. A quote that has run out or been used is `409 quote_changed`
   * with a fresh one in `reason.paymentQuote`.
   */
  @Post('payments')
  @ApiPaySourceHeader()
  @HttpCode(201)
  @BuiltBy('MONEY-17')
  @RequireIdempotentApproval(PAY_ROUTE)
  @AllowWorldWallet()
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
    'payment_in_progress',
    'currency_not_supported',
    'fx_account_not_open',
    'rate_unavailable',
    'provider_declined',
  )
  @RequireFeesSet()
  pay(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PaymentDto,
  ): Promise<PaymentView> {
    return this.payments.pay(wallet, dto, scope);
  }

  /**
   * One payment as it stands now: what the app polls after `pending` (H18,
   * E10) or after `payment_in_progress` (`reason.paymentId`). `pending`
   * becomes `completed`, `failed` or `reversed` once the provider says
   * which; `delivered` is true once what was paid for has reached the buyer
   * (a `completed` payment with `delivered` false is "paid, still opening").
   * Only the payer reads it: another person's payment is the same `404
   * not_found` as one nobody holds. It reads our record only, never the
   * provider, and moves nothing, so it is not behind the fee settings, the
   * key or the PIN. Declared after the quote so `payments/quote` is never
   * read as an id.
   */
  @Get('payments/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-19')
  @RequireOpenWallet({ world: true })
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  payment(
    @CurrentWallet() wallet: OpenWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PaymentView> {
    return this.payments.read(wallet, id);
  }
}
