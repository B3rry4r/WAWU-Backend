import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ValidateReferralQueryDto as ClaimReferralDto } from './dto/referral.dto';
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

  /**
   * POST /referral/claim — remember the code this account arrived with.
   *
   * Called once, right after the account exists. The code was applied before
   * there was anybody to attach it to, so it lived only in the browser until
   * now — and a browser copy does not survive the trip to an email client and
   * back in a new tab.
   */
  @UseGuards(WawuAuthGuard)
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(@CurrentUser() user: WawuJwtClaims, @Body() dto: ClaimReferralDto) {
    await this.referral.claim(user.sub, dto.code);
    return { claimed: true };
  }

  /** GET /referral/mine — the code this account arrived with, if still usable. */
  @UseGuards(WawuAuthGuard)
  @Get('mine')
  async mine(@CurrentUser() user: WawuJwtClaims) {
    return { code: await this.referral.claimedCode(user.sub) };
  }
}
