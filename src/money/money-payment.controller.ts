import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  HoldListQueryDto,
  PaymentDto,
  PaymentQuoteQueryDto,
} from './dto/money-request.dto';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  declaredOnly,
  IdempotencyKeyHeader,
  MoneyErrors,
  TransactionPinHeader,
  WALLET_GATE_ERRORS,
} from './money-contract';
import type {
  HoldPage,
  HoldView,
  PaymentQuoteView,
  PaymentView,
} from './money-view.type';

/**
 * Pay from wallet: one way to pay for anything WAWU sells (MONEY-17), the
 * shortfall and still-confirming answers (MONEY-19), and money held between
 * payer and payee in WAWU's merchant wallet (MONEY-18, R-19). Task MONEY-04
 * contract; see money-contract.ts for why these handlers are declarations.
 *
 * A hold is never moved by a client request: the owning feature releases it
 * (a DM answered, an event that took place, a bill delivered) or refunds it
 * (no answer in time, an event called off, a biller failure). These routes
 * only read holds.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPaymentController {
  /**
   * What the pay sheet shows before the PIN (H14, H17): the price from the
   * server's own record of the item, Fintava's charge, the total, the balance
   * and the shortfall, and whether it fits today's limit. Nothing is
   * reserved. A total above MERCHANT_MAX_PER_TXN_KOBO is amount_out_of_range.
   */
  @Get('payments/quote')
  @BuiltBy('MONEY-17')
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'target_not_found',
    'target_not_payable',
    'amount_out_of_range',
  )
  quote(@Query() query: PaymentQuoteQueryDto): Promise<PaymentQuoteView> {
    return declaredOnly('MONEY-17', query);
  }

  /**
   * Pay from the wallet. Answers completed, or pending when Fintava has not
   * confirmed the debit yet (H18, E10): the app polls GET /money/payments/{id}.
   * A held kind answers with its hold. The money goes through WAWU's
   * merchant wallet, so a total above MERCHANT_MAX_PER_TXN_KOBO (config) is
   * refused with amount_out_of_range and maximumKobo, never split; a total
   * past today's limit is daily_limit_exceeded (Lead rulings, 2 Oct 2026).
   */
  @Post('payments')
  @BuiltBy('MONEY-17')
  @IdempotencyKeyHeader()
  @TransactionPinHeader()
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'daily_limit_exceeded',
    'target_not_found',
    'target_not_payable',
  )
  pay(@Body() dto: PaymentDto): Promise<PaymentView> {
    return declaredOnly('MONEY-17', dto);
  }

  /** One payment, as it stands now. Only the payer can read it. */
  @Get('payments/:id')
  @BuiltBy('MONEY-19')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  payment(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentView> {
    return declaredOnly('MONEY-19', id);
  }

  /** Holds the caller paid (role=payer) or is owed (role=payee), newest first. */
  @Get('holds')
  @BuiltBy('MONEY-18')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  holds(@Query() query: HoldListQueryDto): Promise<HoldPage> {
    return declaredOnly('MONEY-18', query);
  }

  /** One hold. Its payer and its payee can read it; nobody else. */
  @Get('holds/:id')
  @BuiltBy('MONEY-18')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  hold(@Param('id', ParseUUIDPipe) id: string): Promise<HoldView> {
    return declaredOnly('MONEY-18', id);
  }
}
