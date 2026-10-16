import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { BankTransferDto, NameCheckDto } from './dto/money-request.dto';
import {
  BuiltBy,
  DEBIT_GATE_ERRORS,
  declaredOnly,
  IdempotencyKeyHeader,
  MoneyErrors,
  TransactionPinHeader,
} from './money-contract';
import type {
  AccountNameView,
  BankView,
  TransferView,
} from './money-view.type';

/**
 * Sending money to any Nigerian bank account (WALLET-09), with the name
 * check. Sending to another WAWU user and reading one send are served by
 * WALLET-07 (src/money/transfers/); finding a person is WALLET-08
 * (src/money/recipients/). The fee quote is served by WALLET-15
 * (src/money/fees/), saved beneficiaries and the payout account by WALLET-14
 * (src/money/saved-accounts/).
 * A withdrawal (W17) is a bank send to the payout account. Task MONEY-04
 * contract; see money-contract.ts for why these handlers are declarations.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyTransferController {
  /** Fintava's bank list, in one unpaged array. Key on `code`: some names repeat. */
  @Get('banks')
  @BuiltBy('WALLET-09')
  @MoneyErrors('provider_unreachable')
  banks(): Promise<BankView[]> {
    return declaredOnly('WALLET-09');
  }

  /** Whose account this is, from the bank (W8, A21). W8's Continue unlocks only after this answers. */
  @Post('banks/name-check')
  @HttpCode(200)
  @BuiltBy('WALLET-09')
  @MoneyErrors('name_check_failed', 'provider_unreachable')
  nameCheck(@Body() dto: NameCheckDto): Promise<AccountNameView> {
    return declaredOnly('WALLET-09', dto);
  }

  /**
   * Send to a bank account (W10 to W14), or withdraw to the payout account
   * (W17 to W19). Answers pending; the bank's answer arrives later and the
   * app reads it from GET /money/transfers/{id}.
   */
  @Post('transfers/bank')
  @BuiltBy('WALLET-09')
  @IdempotencyKeyHeader()
  @TransactionPinHeader()
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'daily_limit_exceeded',
    'name_check_failed',
    'bank_transfers_blocked',
  )
  sendToBank(@Body() dto: BankTransferDto): Promise<TransferView> {
    return declaredOnly('WALLET-09', dto);
  }
}
