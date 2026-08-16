import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type { CreatorNoResponseTrackerResponse } from '../common/types';
import { CreatorNoResponseTrackerService } from './creator-no-response-tracker.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { ResponseStatsQueryDto } from './dto/response-stats-query.dto';

/**
 * registry.json "CreatorNoResponseTracker" resource — one endpoint.
 * Route lives under `/dm/...` per the registry's own path (not
 * `/creator-no-response-tracker/...`) — it's the DM feature's response-rate
 * stat, this resource just owns its storage/service.
 */
@Controller('dm')
export class CreatorNoResponseTrackerController {
  constructor(private readonly service: CreatorNoResponseTrackerService) {}

  @UseGuards(WawuAuthGuard, CreatorAccountGuard)
  @Get('response-stats')
  async getResponseStats(
    @CurrentUser() user: WawuJwtClaims,
    @Query() _query: ResponseStatsQueryDto,
  ): Promise<CreatorNoResponseTrackerResponse> {
    return this.service.getResponseStats(user.sub);
  }
}
