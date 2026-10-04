import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { PaymentDto, PaymentQuoteQueryDto } from '../dto/money-request.dto';
import {
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
import {
  CurrentIdempotencyScope,
  type IdempotencyScope,
  RequireIdempotentApproval,
} from './idempotency';
import { PAY_ROUTE, WalletPaymentService } from './wallet-payment.service';

/**
 * Pay from wallet (task MONEY-17). Declared by MONEY-04, served here
 * (docs/contract/CONVENTIONS.md sections 0 and 12). `GET
 * /money/payments/{id}` (MONEY-19) and the holds (MONEY-18) stay declared
 * in money-payment.controller.ts.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPaymentsController {
  constructor(private readonly payments: WalletPaymentService) {}

  /**
   * What the pay sheet shows before the PIN (H14, H17): the price from the
   * server's own record of the item, Fintava's charge, the total, the balance
   * and the shortfall, and a signed quote the payment sends back. Nothing is
   * reserved. A total above MERCHANT_MAX_PER_TXN_KOBO is amount_out_of_range.
   * A kind whose feature has not moved onto the wallet yet is
   * target_not_payable.
   */
  @Get('payments/quote')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('MONEY-17')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'amount_out_of_range',
  )
  quote(
    @CurrentWallet() wallet: OpenWallet,
    @Query() query: PaymentQuoteQueryDto,
  ): Promise<PaymentQuoteView> {
    return this.payments.quote(wallet, query);
  }

  /**
   * Pay from the wallet: the price from the buyer's wallet to WAWU's
   * merchant wallet (R-19), Fintava's charge on top (R-10), the 85/15 split
   * of the price recorded with it (R-5). Answers 201 with the payment:
   * completed, pending when Fintava has not confirmed the debit yet (H18,
   * E10; it is never sent again blindly), or failed when Fintava refused it
   * and nothing moved. The same Idempotency-Key and body answer the first
   * result again (`Idempotent-Replayed: true`) without checking the PIN.
   */
  @Post('payments')
  @HttpCode(201)
  @BuiltBy('MONEY-17')
  @RequireIdempotentApproval(PAY_ROUTE)
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'device_approval_refused',
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
    'payment_in_progress',
  )
  pay(
    @CurrentWallet() wallet: OpenWallet,
    @CurrentIdempotencyScope() scope: IdempotencyScope,
    @Body() dto: PaymentDto,
  ): Promise<PaymentView> {
    return this.payments.pay(wallet, dto, scope);
  }
}
