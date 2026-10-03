import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { ConfirmPinResetDto } from './dto/money-request.dto';
import {
  BuiltBy,
  declaredOnly,
  MoneyErrors,
  WALLET_GATE_ERRORS,
} from './money-contract';
import type { PinResetView, PinStateView } from './money-view.type';

/**
 * Reset of the transaction PIN by a code to the phone (MONEY-14). The PIN
 * itself (GET, POST and PUT /money/pin, POST /money/pin/verify) is served by
 * MONEY-09 in src/money/pin/money-pin.controller.ts. The wallet itself,
 * GET /money/wallet, is served by MONEY-12 in
 * src/money/opening/money-wallet-opening.controller.ts, and its balance by
 * MONEY-11 in src/money/balance/money-balance.controller.ts.
 *
 * Every route reads the caller from their token. None takes a wawuUserId:
 * a wallet route that accepts somebody else's id is one slip away from
 * draining their account, as WalletController already says.
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
