import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { PlansService } from './plans.service';
import type { MyTierView } from './plans-view.type';

/**
 * The caller's tier (TIER-01, VF14). Takes no id: there is no way to ask
 * for somebody else's. `/me/tier` is a literal leaf; the other `/me` routes
 * (MeController) declare no parameter at this depth, so neither shadows the
 * other.
 */
@UseGuards(WawuAuthGuard)
@Controller('me')
export class MeTierController {
  constructor(private readonly plans: PlansService) {}

  /**
   * `none`, `active`, `ending` or `ended`, with what the tier gives.
   * `no-store`: the answer is the caller's own.
   */
  @Get('tier')
  @Header('Cache-Control', 'no-store')
  get(@CurrentUser() user: WawuJwtClaims): Promise<MyTierView> {
    return this.plans.myTier(user.sub);
  }
}
