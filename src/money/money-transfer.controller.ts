import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  BankTransferDto,
  CreateBeneficiaryDto,
  FeeQuoteQueryDto,
  NameCheckDto,
  PayoutAccountDto,
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
  BeneficiaryView,
  FeeQuoteView,
  PayoutAccountView,
  RecipientView,
  TransferView,
} from './money-view.type';

/**
 * Sending money: to another WAWU user (WALLET-07, WALLET-08) and to any
 * Nigerian bank account (WALLET-09), with the name check, the fee quote
 * (WALLET-15), saved beneficiaries and the payout account (WALLET-14).
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

  /** Saved beneficiaries, newest first (W8). Their number is WalletView.beneficiaryCount (W35). */
  @Get('beneficiaries')
  @BuiltBy('WALLET-14')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  beneficiaries(): Promise<BeneficiaryView[]> {
    return declaredOnly('WALLET-14');
  }

  /** Save a beneficiary (W12 "Save as beneficiary"). Saving one already saved answers the existing one. */
  @Post('beneficiaries')
  @BuiltBy('WALLET-14')
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'recipient_not_found',
    'recipient_has_no_wallet',
    'self_transfer',
    'name_check_failed',
    'provider_unreachable',
  )
  addBeneficiary(@Body() dto: CreateBeneficiaryDto): Promise<BeneficiaryView> {
    return declaredOnly('WALLET-14', dto);
  }

  /** Remove a saved beneficiary. Removing one already gone is a 200. */
  @Delete('beneficiaries/:id')
  @BuiltBy('WALLET-14')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  removeBeneficiary(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return declaredOnly('WALLET-14', id);
  }

  /** The creator's payout account (A21, W17's default destination), or null when none is saved. */
  @Get('payout-account')
  @BuiltBy('WALLET-14')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  payoutAccount(): Promise<PayoutAccountView | null> {
    return declaredOnly('WALLET-14');
  }

  /** Save or replace the payout account. The server name-checks it and compares the name with the BVN name. */
  @Put('payout-account')
  @BuiltBy('WALLET-14')
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'name_check_failed',
    'provider_unreachable',
  )
  setPayoutAccount(@Body() dto: PayoutAccountDto): Promise<PayoutAccountView> {
    return declaredOnly('WALLET-14', dto);
  }

  /**
   * What a send will cost, before the PIN (W10, W17): Fintava's charge plus
   * WAWU's fee from config (R-10), the total, and whether it fits today's
   * limit. Nothing is reserved; the send repeats totalKobo as expectedTotalKobo.
   */
  @Get('fees/quote')
  @BuiltBy('WALLET-15')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'amount_out_of_range')
  feeQuote(@Query() query: FeeQuoteQueryDto): Promise<FeeQuoteView> {
    return declaredOnly('WALLET-15', query);
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
