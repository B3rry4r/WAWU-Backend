import { Controller, Get, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreditsStateService } from './credits-state.service';
import type { CreditsState } from '../common/types';

/**
 * registry.json "CreditsState" — Community Credits balance + 7-day trial
 * window (product-truths.json invariant: an integer count, never a Naira
 * value, never cashable — CLAUDE.md non-negotiable). roles: ["any"], i.e.
 * any authenticated WAWU user, not just creators.
 */
@Controller('credits')
@UseGuards(WawuAuthGuard)
export class CreditsStateController {
  constructor(private readonly creditsStateService: CreditsStateService) {}

  @Get()
  async getMyCredits(@CurrentUser() user: WawuJwtClaims): Promise<CreditsState> {
    return this.creditsStateService.getOrCreate(user.sub);
  }
}
