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
import { ConfirmPinResetDto } from './dto/money-request.dto';
import {
  BuiltBy,
  declaredOnly,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from './money-contract';
import type { PinResetView, PinStateView, WalletView } from './money-view.type';

/**
 * The Naira wallet itself and its transaction PIN (task MONEY-04 contract;
 * see money-contract.ts for why these handlers are declarations). The
 * balance, GET /money/wallet/balance, is served by MONEY-11 in
 * src/money/balance/money-balance.controller.ts.
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
}

/**
 * Reset of the transaction PIN by a code to the phone (MONEY-14). The PIN
 * itself (GET, POST and PUT /money/pin, POST /money/pin/verify) is served by
 * MONEY-09 in src/money/pin/money-pin.controller.ts.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPinResetController {
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
