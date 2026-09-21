import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { VerificationService } from './verification.service';
import {
  StartVerificationPurchaseDto,
  VerifyVerificationPurchaseDto,
} from './dto/verification-purchase.dto';

/**
 * The paid two-tick surface - `/api/hub/verification/*` once the global
 * prefix is applied.
 *
 * A SECOND controller on the same prefix as VerificationSubmissionController,
 * not a replacement for it. That one owns the old five-rung ladder's
 * submission workflow, which still has rows in review; this one owns the two
 * ticks that replace it. The paths do not overlap (`ladder`, `submissions`
 * there; `pricing`, `me`, `purchase` here) and neither controller declares a
 * bare `:id`, so nothing here can swallow a route there.
 *
 * ── NO TIER, ANYWHERE IN THIS FILE ───────────────────────────────────────
 * There are two ticks, they are independent, and neither outranks the other.
 * Nothing here returns a rung, a level, a score or a rank.
 */
@UseGuards(WawuAuthGuard)
@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  /** What each tick costs today. Configured, not compiled in. */
  @Get('pricing')
  pricing() {
    return this.verification.prices();
  }

  /** The caller's own ticks, the prices, and which they may buy. */
  @Get('me')
  me(@CurrentUser() user: WawuJwtClaims) {
    return this.verification.me(user.sub);
  }

  /**
   * Open a checkout for one tick.
   *
   * `@HttpCode(200)`: the ResponseInterceptor stamps `statusCode: 200` into
   * every success body, so a 201 here would ship a response whose envelope
   * contradicts its own status line. Same reasoning as the events routes.
   */
  @Post('purchase')
  @HttpCode(HttpStatus.OK)
  purchase(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: StartVerificationPurchaseDto,
  ) {
    return this.verification.startPurchase(user.sub, dto);
  }

  /**
   * Confirm the payment with Flutterwave and grant the tick.
   *
   * Nothing is granted anywhere else. The transaction id the client sends is
   * only a claim until this has checked it server-side.
   */
  @Post('purchase/verify')
  @HttpCode(HttpStatus.OK)
  verifyPurchase(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: VerifyVerificationPurchaseDto,
  ) {
    return this.verification.verifyPurchase(user.sub, dto);
  }
}
