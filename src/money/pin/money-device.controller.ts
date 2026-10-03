import {
  Body,
  Controller,
  Delete,
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
import { RegisterApprovalDeviceDto } from '../dto/money-request.dto';
import { BuiltBy, MoneyErrors, WALLET_GATE_ERRORS } from '../money-contract';
import type {
  ApprovalChallengeView,
  ApprovalDeviceView,
  PinStateView,
} from '../money-view.type';
import { ApprovalDeviceService } from './approval-device.service';
import {
  RequireApproval,
  RequireTransactionPin,
} from './transaction-pin.guard';
import { TransactionPinService } from './transaction-pin.service';

/**
 * Approving with a fingerprint or a face instead of the PIN (task MONEY-14,
 * W11, W35; R-26; docs/contract/CONVENTIONS.md section 5). One phone per
 * person holds a key only its biometric unlocks; the server checks that
 * key's signature, never a "true" from the app. ApprovalDeviceService holds
 * every rule.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('money')
export class MoneyDeviceController {
  constructor(
    private readonly devices: ApprovalDeviceService,
    private readonly pins: TransactionPinService,
  ) {}

  /** Which phone, if any, may approve with a fingerprint or face (W35's switch). */
  @Get('device')
  @BuiltBy('MONEY-14')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  device(@CurrentUser() user: WawuJwtClaims): Promise<ApprovalDeviceView> {
    return this.devices.view(user.sub);
  }

  /**
   * Turn it on for this phone (W35): its public key, with the current PIN in
   * X-Transaction-Pin. Replaces any other phone: one per person.
   */
  @Put('device')
  @BuiltBy('MONEY-14')
  @RequireTransactionPin()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
  )
  register(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: RegisterApprovalDeviceDto,
  ): Promise<ApprovalDeviceView> {
    return this.devices.register(user.sub, dto);
  }

  /** Turn it off (W35). Needs no PIN: it only takes a way to approve away. */
  @Delete('device')
  @BuiltBy('MONEY-14')
  @MoneyErrors(...WALLET_GATE_ERRORS)
  remove(@CurrentUser() user: WawuJwtClaims): Promise<ApprovalDeviceView> {
    return this.devices.remove(user.sub);
  }

  /** One challenge for one approval, for the registered phone to sign with the request. */
  @Post('device/challenge')
  @BuiltBy('MONEY-14')
  @MoneyErrors(...WALLET_GATE_ERRORS, 'device_approval_refused')
  challenge(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<ApprovalChallengeView> {
    return this.devices.challenge(user.sub);
  }

  /**
   * Check an approval, the PIN or a fingerprint or face, without moving
   * money: what every debit asks for, for a screen that must confirm the
   * person first (and for W35 to confirm the phone's key works). A PIN try
   * counts as on a debit; a refused biometric approval uses none.
   */
  @Post('approval/verify')
  @HttpCode(200)
  @BuiltBy('MONEY-14')
  @RequireApproval()
  @MoneyErrors(
    ...WALLET_GATE_ERRORS,
    'pin_required',
    'pin_not_set',
    'pin_incorrect',
    'pin_locked',
    'device_approval_refused',
  )
  verify(@CurrentUser() user: WawuJwtClaims): Promise<PinStateView> {
    // The guard has checked the approval by now.
    return this.pins.state(user.sub);
  }
}
