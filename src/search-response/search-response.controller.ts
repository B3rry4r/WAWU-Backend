import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { OptionalWawuAuthGuard } from './guards/optional-wawu-auth.guard';
import { SearchResponseService } from './search-response.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { ClosestSearchQueryDto } from './dto/closest-search-query.dto';

/**
 * registry.json "SearchResponse" — `roles: ["any"]` on every endpoint,
 * read here as genuinely public (see OptionalWawuAuthGuard's doc comment
 * for why that reading differs from e.g. LearnEntitlement's "any
 * *authenticated*"). `OptionalWawuAuthGuard` on every route so a valid
 * bearer token still personalizes the response (unlock state, future
 * recent-searches) without requiring one.
 */
@UseGuards(OptionalWawuAuthGuard)
@Controller('search')
export class SearchResponseController {
  constructor(private readonly searchResponseService: SearchResponseService) {}

  @Get()
  search(
    @Query() query: SearchQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.searchResponseService.search(
      query.q,
      query.tab ?? 'all',
      user?.sub,
    );
  }

  @Get('suggestions')
  suggestions(@CurrentUser() user: WawuJwtClaims | undefined) {
    // OptionalWawuAuthGuard still runs here (controller-level @UseGuards)
    // so req.user is already populated for whenever recentSearches gains
    // persistence — see SearchResponseService.suggestions()'s doc comment.
    return this.searchResponseService.suggestions(user?.sub);
  }

  @Get('closest')
  closest(
    @Query() query: ClosestSearchQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.searchResponseService.closest(query.q, user?.sub);
  }
}
