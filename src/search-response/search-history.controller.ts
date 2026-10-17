import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { OptionalWawuAuthGuard } from './guards/optional-wawu-auth.guard';
import { RecordRecentSearchDto } from './dto/record-recent-search.dto';
import {
  ClearedSearches,
  SearchHistoryService,
  SearchTextList,
} from './search-history.service';

/**
 * EXPLORE-05: Recent (with Clear) and "People are searching" on the Search
 * landing. The two person routes need a signed-in caller; the popular list is
 * public like the rest of search.
 */
@Controller('search')
export class SearchHistoryController {
  constructor(private readonly history: SearchHistoryService) {}

  /**
   * Remember what the caller searched, when they submit it (not on every key
   * they type). Answers their recent searches, newest first.
   */
  @Post('recent')
  @UseGuards(WawuAuthGuard)
  record(
    @Body() body: RecordRecentSearchDto,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<SearchTextList> {
    return this.history.record(user.sub, body.q);
  }

  /** Clear: forget every recent search of the caller's. */
  @Delete('recent')
  @UseGuards(WawuAuthGuard)
  clear(@CurrentUser() user: WawuJwtClaims): Promise<ClearedSearches> {
    return this.history.clear(user.sub);
  }

  /**
   * What many different people searched lately, most first. May be empty:
   * only searches made by enough people appear.
   */
  @Get('popular')
  @UseGuards(OptionalWawuAuthGuard)
  popular(): Promise<SearchTextList> {
    return this.history.popular();
  }
}
