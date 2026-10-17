import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { ClaimReferralDto } from './dto/claim-referral.dto';
import { ReferralsService } from './referrals.service';
import type { ClaimReferralView, MyReferralsView } from './referral-view.type';

/**
 * Invite and earn (task REF-02, RF1 to RF4). The caller is the token: neither
 * route takes an id of whose referrals, so nobody else's can be asked for.
 *
 * Mounted through MeModule, like `me/points` (`/me` is a first segment no
 * other controller declares, and MeController has no `/me/:x` to shadow
 * `referrals`).
 */
@UseGuards(WawuAuthGuard)
@Controller('me/referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  /** The link and code, brought, verified, points earned and pending, the level and the next milestone. */
  @Get()
  @Header('Cache-Control', 'no-store')
  mine(@CurrentUser() user: WawuJwtClaims): Promise<MyReferralsView> {
    return this.referrals.view(user);
  }

  /** Uses someone's code: once, in your first days, never your own. */
  @Post('claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  claim(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: ClaimReferralDto,
  ): Promise<ClaimReferralView> {
    return this.referrals.claim(user.sub, dto.code);
  }
}
