import { Injectable } from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { BrowseMoviesQueryDto, SearchMoviesQueryDto } from './movies.dto';
import { MoviesError, MOVIES_OFF_MESSAGE } from './movies-error';
import type {
  MovieCardView,
  MovieDetailView,
  MovieFiltersView,
  MoviesHomeView,
  MovieWatchView,
} from './movies-view.type';

/** FLIX-01. */
@Injectable()
export class MoviesService {
  home(): Promise<MoviesHomeView> {
    return Promise.resolve({ enabled: false, hero: null, rails: [] });
  }

  browse(query: BrowseMoviesQueryDto): Promise<Paginated<MovieCardView>> {
    void query;
    return Promise.reject(off());
  }

  filters(): Promise<MovieFiltersView> {
    return Promise.reject(off());
  }

  search(query: SearchMoviesQueryDto): Promise<Paginated<MovieCardView>> {
    void query;
    return Promise.reject(off());
  }

  detail(user: WawuJwtClaims, movieId: string): Promise<MovieDetailView> {
    void [user, movieId];
    return Promise.reject(off());
  }

  watch(
    user: WawuJwtClaims,
    movieId: string,
    agreeToTerms: boolean,
  ): Promise<MovieWatchView> {
    void [user, movieId, agreeToTerms];
    return Promise.reject(off());
  }
}

function off(): MoviesError {
  return new MoviesError('movies_off', MOVIES_OFF_MESSAGE);
}
