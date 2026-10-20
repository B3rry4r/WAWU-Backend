import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { OptionalWawuAuthGuard } from './guards/optional-wawu-auth.guard';
import { SearchResponseService } from './search-response.service';
import {
  SearchPeopleService,
  type SearchPeople,
} from './search-people.service';
import { SearchQueryDto } from './dto/search-query.dto';
import {
  MAX_PEOPLE_PER_CALL,
  PERSON_ID_PATTERN,
  SearchPeopleQueryDto,
} from './dto/search-people-query.dto';
import { ClosestSearchQueryDto } from './dto/closest-search-query.dto';
import { refuseUnsearchableQuery } from './searchable-query';

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
  constructor(
    private readonly searchResponseService: SearchResponseService,
    private readonly searchPeople: SearchPeopleService,
  ) {}

  @Get()
  search(
    @Query() query: SearchQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    // FIX-07: a `q` with a NUL (or a lone surrogate) is a 400 naming `q` on
    // every tab, before any query runs, never the 500 Postgres caused. A line
    // comment, not JSDoc: the swagger plugin would copy JSDoc into the contract.
    refuseUnsearchableQuery(query.q);
    const asked = [query.q, query.tab ?? 'all', user?.sub] as const;
    // EXPLORE-05: the community rows are for a caller that asks for them;
    // every other request reaches the service exactly as it always did.
    return query.include === 'communities'
      ? this.searchResponseService.search(...asked, { communities: true })
      : this.searchResponseService.search(...asked);
  }

  /**
   * The caller's `recentSearches` are filled only when the request carries
   * `include=recent` (the app sends it); without it the answer is what the
   * web has always had, with `recentSearches` empty.
   */
  @Get('suggestions')
  @ApiQuery({
    name: 'include',
    required: false,
    enum: ['recent'],
    description:
      "Send `recent` to have `recentSearches` filled with the signed-in caller's own recent searches. Left out, `recentSearches` is empty, as it always was for the web.",
  })
  suggestions(
    @Query('include') include: unknown,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    // A line comment, not JSDoc, for the same reason as in search() above.
    // Only a request that carries `include` meets this check, so a call the
    // web makes (it sends none) is never refused for it.
    if (include !== undefined && include !== 'recent')
      throw new BadRequestException('include must be recent');
    return this.searchResponseService.suggestions(user?.sub, {
      recent: include === 'recent',
    });
  }

  /**
   * EXPLORE-02. The names the app draws on result rows and "Creators to know":
   * for each account asked about, who they are (real name or handle, picture,
   * what they do, both ticks) and whether the caller follows them. A person
   * the caller may not see is left out of the answer. New route: nothing the
   * web calls changes.
   */
  @Get('people')
  people(
    @Query() query: SearchPeopleQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ): Promise<SearchPeople> {
    const ids = query.ids.split(',').filter((id) => id !== '');
    if (
      ids.length === 0 ||
      ids.length > MAX_PEOPLE_PER_CALL ||
      ids.some((id) => !PERSON_ID_PATTERN.test(id))
    ) {
      throw new BadRequestException(
        `ids must name 1 to ${MAX_PEOPLE_PER_CALL} accounts`,
      );
    }
    return this.searchPeople.people(ids, user?.sub);
  }

  @Get('closest')
  closest(
    @Query() query: ClosestSearchQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    // FIX-07: the same refusal as GET /search, for the same reason.
    refuseUnsearchableQuery(query.q);
    return this.searchResponseService.closest(query.q, user?.sub);
  }
}
