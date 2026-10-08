import { Controller, Get, UseGuards } from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { PlansService } from './plans.service';
import type { PlansView } from './plans-view.type';

/**
 * The maker plan's prices (TIER-01): tiers, extra products, points packs,
 * the checkout offer, what AI actions cost and the caps, in the caller's
 * billing currency only. Signed in, because the currency is the caller's.
 * `plans` is a first segment no other controller declares.
 */
@UseGuards(WawuAuthGuard)
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /**
   * The plan as the caller pays for it. Every amount is whole minor units of
   * `currency` (kobo for NGN, cents for USD); one currency per answer.
   */
  @Get()
  get(@CurrentUser() user: WawuJwtClaims): Promise<PlansView> {
    return this.plans.plansFor(user.sub, user.phone);
  }
}
