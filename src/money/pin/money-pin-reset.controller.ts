import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { ConfirmPinResetDto } from '../dto/money-request.dto';
import { AllowWorldWallet, RequireOpenWallet } from '../gate/wallet-gate';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { PinResetView, PinStateView } from '../money-view.type';
import {
  CurrentPinRequestKey,
  RequireOpenWalletWithKey,
} from './pin-request-key';
import {
  PIN_RESET_CONFIRM_ROUTE,
  PinRequestKeys,
} from './pin-request-keys.service';
import type { IdempotencyScope } from '../payments/idempotency';
import { PinResetService } from './pin-reset.service';

/**
 * Forgot PIN (W37), served (task MONEY-14). Declared by MONEY-04; the
 * request and response types are the contract's own. A code goes by text
 * to the phone the BVN check proved, then the code and the new PIN (W36)
 * come back together. PinResetService holds every rule.
 *
 * Every route reads the caller from the token and never takes a wawuUserId
 * or a phone number: the code can only go to the proved phone on file. Both
 * are behind the wallet gate (MONEY-13): the PIN is set once the wallet is
 * open (A9 after A8), so a reset is for a wallet holder.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
// WALLET-41 round 1: the PIN, the phone's approval and the PIN reset never read the naira wallet, and a person outside
// Nigeria needs them to swap and send: they take an open wallet of any kind.
@AllowWorldWallet()
@Controller('money')
export class MoneyPinResetController {
  constructor(
    private readonly resets: PinResetService,
    private readonly keyed: PinRequestKeys,
  ) {}

  /**
   * Forgot PIN (W37): send a code to the phone on file. Asked again before
   * resendAvailableAt, it answers the same reset and sends nothing; after
   * it, a new code (the old one stops working).
   */
  @Post('pin/reset')
  @BuiltBy('MONEY-14')
  @RequireOpenWallet()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_not_set',
    'reset_codes_exhausted',
    'provider_unreachable',
  )
  startReset(@CurrentUser() user: WawuJwtClaims): Promise<PinResetView> {
    return this.resets.start(user.sub, { email: user.email ?? null });
  }

  /** The code and the new PIN. Clears the lock and the wrong-try count, and turns biometric approval off. */
  @Post('pin/reset/confirm')
  @HttpCode(200)
  @BuiltBy('MONEY-14')
  @RequireOpenWalletWithKey(PIN_RESET_CONFIRM_ROUTE)
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'reset_code_invalid',
    'pin_mismatch',
    'pin_not_set',
    'pin_changed_again',
  )
  confirmReset(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ConfirmPinResetDto,
    @CurrentPinRequestKey() key: IdempotencyScope | undefined,
  ): Promise<PinStateView> {
    // An optional Idempotency-Key makes a repeat answer the first outcome
    // (WALLET-06 round 2): a code works once, so without it the repeat of a
    // reset that landed is refused as a code already used. See
    // pin-request-keys.service.ts.
    return this.keyed.under(key, user.sub, (inTransaction) =>
      this.resets.confirm(user.sub, dto, inTransaction),
    );
  }
}
