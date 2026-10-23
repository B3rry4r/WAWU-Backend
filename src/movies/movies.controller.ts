import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { BuiltBy } from '../money/money-contract';
import {
  BrowseMoviesQueryDto,
  SearchMoviesQueryDto,
  WatchMovieDto,
} from './movies.dto';
import { MoviesService } from './movies.service';
import type {
  MovieCardView,
  MovieDetailView,
  MovieFiltersView,
  MoviesHomeView,
  MovieWatchView,
} from './movies-view.type';

/**
 * Flix movies (FLIX-01, R-74, R-75, Flow MV): the partner's catalog as the Hub
 * keeps it, and a signed-in link to watch a title on the partner's site. The
 * app never calls the partner. Every route reads the Hub's own copy of the
 * catalog; only `watch` reaches the partner, through the `MOVIE_PARTNER` seam.
 *
 * `MOVIE_PARTNER=off` (the default; empty is off): `GET /movies` answers
 * `{ enabled: false, hero: null, rails: [] }` and every other route answers
 * `404 movies_off`, with no call to anyone and no link. `MOVIE_PARTNER=soon`
 * (FLIX-04, R-77) answers the same, with `soon: true` on `GET /movies` so the
 * app shows "not live yet" instead of hiding movies.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('movies')
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  /** The movies screen and the rails on Home and Explore: a hero and the rails (new, most watched, top rated, premiering soon). Empty rails are left out. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FLIX-01')
  home(): Promise<MoviesHomeView> {
    return this.movies.home();
  }

  /** "See all": the whole catalog copy, a page at a time, with a total. Sort `newest` (default), `rating`, `views` or `title`; filter by `genre`, `language` and `premiering`. */
  @Get('browse')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FLIX-01')
  browse(
    @Query() query: BrowseMoviesQueryDto,
  ): Promise<Paginated<MovieCardView>> {
    return this.movies.browse(query);
  }

  /** The genres and languages the catalog holds now, for the filter sheet. */
  @Get('filters')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FLIX-01')
  filters(): Promise<MovieFiltersView> {
    return this.movies.filters();
  }

  /** Search the catalog copy by title, original title or tagline, newest first. */
  @Get('search')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FLIX-01')
  search(
    @Query() query: SearchMoviesQueryDto,
  ): Promise<Paginated<MovieCardView>> {
    return this.movies.search(query);
  }

  /** One title with its trailer (kind `file` or `youtube`) and whether this person must agree to the terms first (`mustAgreeTerms`). `404 movie_not_found` for a title the catalog does not hold. */
  @Get(':movieId')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FLIX-01')
  detail(
    @CurrentUser() user: WawuJwtClaims,
    @Param('movieId') movieId: string,
  ): Promise<MovieDetailView> {
    return this.movies.detail(user, movieId);
  }

  /**
   * "Watch on Flixora": a fresh signed-in link for this tap, `{ url,
   * expiresAt }`. The first link opens the person's account on the partner's
   * side (R-75). `409 terms_not_agreed` until the person has agreed (signed up
   * on or after `FLIXORA_TERMS_FROM`, or `agreeToTerms: true`, which is stored
   * with its time first). `503 movies_unavailable` when the partner cannot
   * make a link right now. The link is never stored and never logged.
   */
  @Post(':movieId/watch')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('FLIX-01')
  watch(
    @CurrentUser() user: WawuJwtClaims,
    @Param('movieId') movieId: string,
    @Body() dto: WatchMovieDto,
  ): Promise<MovieWatchView> {
    return this.movies.watch(user, movieId, dto.agreeToTerms === true);
  }
}
