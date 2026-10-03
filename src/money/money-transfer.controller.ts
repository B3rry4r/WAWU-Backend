import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  BankTransferDto,
  NameCheckDto,
  RecipientSearchQueryDto,
  WawuTransferDto,
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
  AccountNameView,
  BankView,
  RecipientView,
  TransferView,
} from './money-view.type';

/**
 * Sending money: to another WAWU user (WALLET-07, WALLET-08) and to any
 * Nigerian bank account (WALLET-09), with the name check. The fee quote is
 * served by WALLET-15 (src/money/fees/), saved beneficiaries and the payout
 * account by WALLET-14 (src/money/saved-accounts/).
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

  /** WAWU users with an open wallet, by name, @handle or phone (W7). Blocked people never appear. At most 20. */
  @Get('recipients')
  @BuiltBy('WALLET-08')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  recipients(
    @Query() query: RecipientSearchQueryDto,
  ): Promise<RecipientView[]> {
    return declaredOnly('WALLET-08', query);
  }

  /** The people this user sent money to most recently, newest first (W7). At most 10. */
  @Get('recipients/recent')
  @BuiltBy('WALLET-08')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  recentRecipients(): Promise<RecipientView[]> {
    return declaredOnly('WALLET-08');
  }

  /** Send to a WAWU user (W10 to W12). Completes at once or is refused; never pending. */
  @Post('transfers/wawu')
  @BuiltBy('WALLET-07')
  @IdempotencyKeyHeader()
  @TransactionPinHeader()
  @MoneyErrors(
    ...DEBIT_GATE_ERRORS,
    'daily_limit_exceeded',
    'recipient_not_found',
    'recipient_has_no_wallet',
    'recipient_blocked',
    'self_transfer',
  )
  sendToWawuUser(@Body() dto: WawuTransferDto): Promise<TransferView> {
    return declaredOnly('WALLET-07', dto);
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

  /** One send, as it stands now (W12 receipt, W14 failed, W19 timeline). Only the sender can read it. */
  @Get('transfers/:id')
  @BuiltBy('WALLET-07')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'not_found')
  transfer(@Param('id', ParseUUIDPipe) id: string): Promise<TransferView> {
    return declaredOnly('WALLET-07', id);
  }
}
