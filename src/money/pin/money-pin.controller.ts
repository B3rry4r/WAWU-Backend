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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { ChangePinDto, SetPinDto } from '../dto/money-request.dto';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type { PinStateView } from '../money-view.type';
import { RequireTransactionPin } from './transaction-pin.guard';
import { TransactionPinService } from './transaction-pin.service';

/**
 * The transaction PIN, served (task MONEY-09). Declared by MONEY-04; the
 * request and response types are the contract's own, unchanged. Reset by a
 * code to the phone (POST /money/pin/reset and /reset/confirm) is MONEY-14's,
 * in money-pin-reset.controller.ts.
 *
 * Every route reads the caller from the token and never takes a wawuUserId.
 * The refusals each route documents are the contract's; the wallet gate
 * codes (wallet_not_open, wallet_opening, wallet_frozen) are answered once
 * MONEY-12 and MONEY-13 store a wallet's state (BACKEND_GAPS in the mobile
 * repo): nothing records one yet.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyPinController {
  constructor(private readonly pins: TransactionPinService) {}

  /** Is a PIN set, when it last changed, tries left, and the lock if any. */
  @Get('pin')
  @BuiltBy('MONEY-09')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  state(@CurrentUser() user: WawuJwtClaims): Promise<PinStateView> {
    return this.pins.state(user.sub);
  }

  /** Set the first PIN (A9, A10, W36). Both entries in one request; a difference is pin_mismatch. */
  @Post('pin')
  @BuiltBy('MONEY-09')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'pin_already_set', 'pin_mismatch')
  set(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: SetPinDto,
  ): Promise<PinStateView> {
    return this.pins.set(user.sub, dto);
  }

  /** Change the PIN. The current PIN is X-Transaction-Pin. */
  @Put('pin')
  @BuiltBy('MONEY-09')
  @RequireTransactionPin()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
    'pin_mismatch',
  )
  change(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ChangePinDto,
  ): Promise<PinStateView> {
    return this.pins.change(user.sub, dto);
  }

  /**
   * Check the PIN without moving money, for a screen that must confirm the
   * person before it changes something. A wrong PIN counts toward the lock
   * exactly as it does on a debit.
   */
  @Post('pin/verify')
  @HttpCode(200)
  @BuiltBy('MONEY-09')
  @RequireTransactionPin()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
  )
  verify(@CurrentUser() user: WawuJwtClaims): Promise<PinStateView> {
    // The guard has checked the PIN (and reset the count) by now.
    return this.pins.state(user.sub);
  }
}
