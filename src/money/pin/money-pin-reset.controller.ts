import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { ConfirmPinResetDto } from '../dto/money-request.dto';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { PinResetView, PinStateView } from '../money-view.type';
import { PinResetService } from './pin-reset.service';

/**
 * Forgot PIN (W37), served (task MONEY-14). Declared by MONEY-04; the
 * request and response types are the contract's own. A code goes by text
 * to the phone the BVN check proved, then the code and the new PIN (W36)
 * come back together. PinResetService holds every rule.
 *
 * Every route reads the caller from the token and never takes a wawuUserId
 * or a phone number: the code can only go to the proved phone on file.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPinResetController {
  constructor(private readonly resets: PinResetService) {}

  /**
   * Forgot PIN (W37): send a code to the phone on file. Asked again before
   * resendAvailableAt, it answers the same reset and sends nothing; after
   * it, a new code (the old one stops working).
   */
  @Post('pin/reset')
  @BuiltBy('MONEY-14')
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_not_set',
    'reset_codes_exhausted',
    'provider_unreachable',
  )
  startReset(@CurrentUser() user: WawuJwtClaims): Promise<PinResetView> {
    return this.resets.start(user.sub);
  }

  /** The code and the new PIN. Clears the lock and the wrong-try count, and turns biometric approval off. */
  @Post('pin/reset/confirm')
  @HttpCode(200)
  @BuiltBy('MONEY-14')
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'reset_code_invalid',
    'pin_mismatch',
    'pin_not_set',
  )
  confirmReset(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ConfirmPinResetDto,
  ): Promise<PinStateView> {
    return this.resets.confirm(user.sub, dto);
  }
}
