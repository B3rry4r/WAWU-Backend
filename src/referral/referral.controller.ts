import { Controller, Get, Query } from '@nestjs/common';
import { ReferralService } from './referral.service';
import { ValidateReferralQueryDto } from './dto/referral.dto';
import { PRICE_TABLE } from '../creator-subscription/creator-subscription.service';

/**
 * The two things the sign-up screen needs before anybody has an account.
 *
 * Both are deliberately UNAUTHENTICATED: they are read by somebody who is not
 * signed in and by definition cannot be. Neither leaks anything — the settings
 * route returns one boolean, and validate returns a price the pricing page
 * already shows publicly.
 */
@Controller('referral')
export class ReferralController {
  constructor(private readonly referral: ReferralService) {}

  /** Whether an account can be created without a code. */
  @Get('signup-state')
  async signupState() {
    return { userSignupEnabled: await this.referral.userSignupEnabled() };
  }

  /**
   * GET /referral/validate?code=... — checks a code and prices it.
   *
   * Has no side effects on purpose: this is called while somebody is still
   * typing, and incrementing a use here would burn a single-use code on a
   * keystroke.
   */
  @Get('validate')
  validate(@Query() query: ValidateReferralQueryDto) {
    return this.referral.validate(query.code, PRICE_TABLE);
  }
}
