import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { ClaimWaitlistRegistrationDto } from './dto/waitlist.dto';
import { WaitlistClaimService } from './waitlist-claim.service';
import type { WaitlistClaimView } from './waitlist-view.type';

/**
 * Claim the plan an event registration paid for (JOIN-03, R-48). A signed-in
 * route: the caller is the WAWU ID account in the token, and there is no way
 * to name anybody else. `waitlist/claims` is a literal no other controller
 * declares, beside the public `waitlist/registrations` routes.
 *
 * Every refusal is the one error shape with a stable `reason.code`
 * (waitlist-error.ts); the app switches on the code, never on the message.
 * No override of its own: the app's global limits per address apply (20 a
 * second, 200 a minute). The proof of a verified phone or email, not the
 * rate, is what keeps a code from being claimed by the wrong person, and an
 * unknown code, an unpaid one and somebody else's answer the same, so
 * guessing codes learns nothing.
 */
@UseGuards(WawuAuthGuard)
@Controller('waitlist')
export class WaitlistClaimController {
  constructor(private readonly claims: WaitlistClaimService) {}

  /**
   * Claim a paid registration with its launch access code. The caller must
   * hold the registration's phone or email, proven to WAWU ID; the code alone
   * is never enough. Gives what the registration's plan gives, its days
   * counted from now, once. The account that made the claim and sends the
   * same code again is answered with the same plan (a 200, nothing granted
   * twice), so an answer that was lost on the way can be asked for again.
   */
  @Post('claims')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiResponse({
    status: 400,
    description:
      '`reason.code` `code_invalid`: not 8 letters and numbers. A malformed body has no `reason`.',
  })
  @ApiResponse({
    status: 404,
    description:
      '`reason.code` `code_not_found`: the same answer for a code that does not exist, is not paid, or is not tied to a phone or email the caller has proven.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`reason.code` `contact_not_verified` (the account has no proven phone or email), `code_refunded` (an extra payment being refunded), `already_claimed` (by another account), `offer_unavailable`, or `claimed_by_you` (only for a claim made before its answer was kept; the same account asking again is otherwise answered 200).',
  })
  claim(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ClaimWaitlistRegistrationDto,
  ): Promise<WaitlistClaimView> {
    return this.claims.claim(user, dto.code);
  }
}
