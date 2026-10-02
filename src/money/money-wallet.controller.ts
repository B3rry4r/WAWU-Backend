import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import {
  ChangePinDto,
  ConfirmPinResetDto,
  SetPinDto,
} from './dto/money-request.dto';
import {
  BuiltBy,
  declaredOnly,
  MoneyErrors,
  TransactionPinHeader,
  WALLET_GATE_ERRORS,
} from './money-contract';
import type {
  PinResetView,
  PinStateView,
  WalletBalanceView,
  WalletView,
} from './money-view.type';

/**
 * The Naira wallet itself and its transaction PIN (task MONEY-04 contract;
 * see money-contract.ts for why these handlers are declarations).
 *
 * Every route reads the caller from their token. None takes a wawuUserId:
 * a wallet route that accepts somebody else's id is one slip away from
 * draining their account, as WalletController already says.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyWalletController {
  /**
   * The wallet as WAWU records it: state, account details, limits, PIN state.
   * Never calls Fintava and never carries a balance. With no wallet it answers
   * 200 with state not_open (R-6), so the Wallet tab can lead to Open your wallet.
   */
  @Get('wallet')
  @BuiltBy('MONEY-12')
  wallet(): Promise<WalletView> {
    return declaredOnly('MONEY-12');
  }

  /**
   * Fintava's available balance, asked for on every call (W1, W9, W13).
   * 503 provider_unreachable when the bank does not answer (W6): never a 0.
   */
  @Get('wallet/balance')
  @BuiltBy('MONEY-11')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'provider_unreachable')
  balance(): Promise<WalletBalanceView> {
    return declaredOnly('MONEY-11');
  }
}

/** The transaction PIN (MONEY-09) and its reset by a code to the phone (MONEY-14). */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPinController {
  /** Is a PIN set, when it last changed, tries left, and the lock if any. */
  @Get('pin')
  @BuiltBy('MONEY-09')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  state(): Promise<PinStateView> {
    return declaredOnly('MONEY-09');
  }

  /** Set the first PIN (A9, A10, W36). Both entries in one request; a difference is pin_mismatch. */
  @Post('pin')
  @BuiltBy('MONEY-09')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_already_set', 'pin_mismatch')
  set(@Body() dto: SetPinDto): Promise<PinStateView> {
    return declaredOnly('MONEY-09', dto);
  }

  /** Change the PIN. The current PIN is X-Transaction-Pin. */
  @Put('pin')
  @BuiltBy('MONEY-09')
  @TransactionPinHeader()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
    'pin_mismatch',
  )
  change(@Body() dto: ChangePinDto): Promise<PinStateView> {
    return declaredOnly('MONEY-09', dto);
  }

  /**
   * Check the PIN without moving money, for a screen that must confirm the
   * person before it changes something. A wrong PIN counts toward the lock
   * exactly as it does on a debit.
   */
  @Post('pin/verify')
  @HttpCode(200)
  @BuiltBy('MONEY-09')
  @TransactionPinHeader()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
  )
  verify(): Promise<PinStateView> {
    return declaredOnly('MONEY-09');
  }

  /** Forgot PIN (W37): send a code to the phone on file. Answers again with a new code once resendAvailableAt has passed. */
  @Post('pin/reset')
  @BuiltBy('MONEY-14')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_not_set')
  startReset(): Promise<PinResetView> {
    return declaredOnly('MONEY-14');
  }

  /** The code and the new PIN. Clears the lock and the wrong-try count. */
  @Post('pin/reset/confirm')
  @HttpCode(200)
  @BuiltBy('MONEY-14')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'reset_code_invalid', 'pin_mismatch')
  confirmReset(@Body() dto: ConfirmPinResetDto): Promise<PinStateView> {
    return declaredOnly('MONEY-14', dto);
  }
}
