import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CreateWaitlistRegistrationDto,
  VerifyWaitlistRegistrationDto,
} from './dto/waitlist.dto';
import { WAITLIST_THROTTLE } from './waitlist-config';
import { WaitlistService } from './waitlist.service';
import type {
  WaitlistOfferView,
  WaitlistRegistrationStartView,
  WaitlistRegistrationStatusView,
} from './waitlist-view.type';

/**
 * The event registration link (JOIN-01, R-48): a person at an event registers
 * and pays the event fee on the website. Public: no sign-in, no WAWU ID
 * account, no password or code. `waitlist` is a first segment no other
 * controller declares.
 *
 * Every refusal is the one error shape with a stable `reason.code`
 * (waitlist-error.ts); the website switches on the code, never on the message.
 * All four routes are throttled per address on the app's `medium` throttler
 * (WAITLIST_THROTTLE): a whole event venue shares one Wi-Fi address. Every
 * answer is `no-store`.
 */
@Throttle(WAITLIST_THROTTLE)
@Controller('waitlist')
export class WaitlistPublicController {
  constructor(private readonly waitlist: WaitlistService) {}

  /** The offer open for registration. */
  @Get('offers/current')
  @Header('Cache-Control', 'no-store')
  @ApiResponse({
    status: 404,
    description: '`reason.code` `no_open_offer`: no offer is open now.',
  })
  currentOffer(): WaitlistOfferView {
    return this.waitlist.currentOffer();
  }

  /**
   * Register and get the checkout settings. Reuses this person's own unpaid
   * registration (same offer, phone and email) rather than adding another.
   * Nothing is charged here: the payment happens in the Flutterwave checkout
   * with the answer's `flutterwaveConfig`, and counts only after
   * POST /waitlist/registrations/verify (or Flutterwave's own notice).
   */
  @Post('registrations')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiResponse({
    status: 400,
    description:
      '`reason.code` `phone_invalid`, `email_invalid`, `name_invalid` or `consent_required`; a malformed body has no `reason`.',
  })
  @ApiResponse({
    status: 404,
    description: '`reason.code` `no_open_offer`: no offer has this id.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`reason.code` `offer_closed` (closed or not open yet) or `already_registered` (this phone or email already paid; nothing is charged).',
  })
  @ApiResponse({
    status: 503,
    description:
      '`reason.code` `payments_unavailable`: payments are not set up.',
  })
  register(
    @Body() dto: CreateWaitlistRegistrationDto,
  ): Promise<WaitlistRegistrationStartView> {
    return this.waitlist.register(dto);
  }

  /**
   * Confirm a payment. The server asks Flutterwave itself (succeeded, this
   * registration's reference, naira, not less than the fee) before it marks
   * the registration paid, so the transaction id is only a claim. Idempotent:
   * a paid registration answers the same result again.
   */
  @Post('registrations/verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiResponse({
    status: 404,
    description:
      '`reason.code` `not_found`: no registration has this reference.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`reason.code` `payment_not_confirmed` (Flutterwave does not say it succeeded yet: check again, never pay again), `transaction_already_used` or `already_registered`.',
  })
  @ApiResponse({
    status: 422,
    description:
      "`reason.code` `payment_mismatch`: the payment is not this registration's (amount, currency or reference).",
  })
  @ApiResponse({
    status: 503,
    description:
      '`reason.code` `payment_check_unavailable`: Flutterwave could not be reached; try the check again.',
  })
  verify(
    @Body() dto: VerifyWaitlistRegistrationDto,
  ): Promise<WaitlistRegistrationStatusView> {
    return this.waitlist.verify(dto);
  }

  /** Where a registration stands: status and first name only, never a phone or email. */
  @Get('registrations/:reference')
  @Header('Cache-Control', 'no-store')
  @ApiResponse({
    status: 404,
    description:
      '`reason.code` `not_found`: the same answer for a reference that does not exist and one that was never issued.',
  })
  status(
    @Param('reference') reference: string,
  ): Promise<WaitlistRegistrationStatusView> {
    return this.waitlist.status(reference);
  }
}
