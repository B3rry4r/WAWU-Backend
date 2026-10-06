import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import type { EvgScore } from '../common/types';
import { EvgScoreService } from './evg-score.service';

/**
 * registry.json "EvgScore" — single read endpoint, `roles: ["any"]`
 * (conventions.md § Roles & permissions guard idiom: "any authenticated
 * user" -> WawuAuthGuard, no resource-specific gate).
 */
@Controller('creators')
@UseGuards(WawuAuthGuard)
export class EvgScoreController {
  constructor(private readonly evgScoreService: EvgScoreService) {}

  @Get(':wawuId/evg')
  getEvgScore(
    @Param('wawuId', new ParseUUIDPipe({ version: '4' })) wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<EvgScore> {
    return this.evgScoreService.getForCreator(wawuId, user.sub);
  }
}
