import {
  MoviePartnerError,
  type ListMoviesRequest,
  type MoviePartner,
  type PartnerLink,
  type PartnerLinkTarget,
  type PartnerMovie,
  type PartnerMoviePage,
  type PartnerPerson,
} from './movie-partner.interface';

/**
 * `MOVIE_PARTNER=soon` (FLIX-04, R-77): movies stay visible in the app as
 * "not live yet" while business talks finish, and do nothing. There is no
 * partner behind it: no sync runs, no catalog is served, no account is
 * opened and no link is given. `GET /movies` answers `soon: true`; every
 * other movies route answers 404 `movies_off`, as `off` does. The Hub checks
 * `enabled` before it asks, so these throw only if something forgot to.
 */
export class SoonMoviePartner implements MoviePartner {
  readonly name = 'soon' as const;
  readonly enabled = false;
  readonly soon = true;

  listMovies(req: ListMoviesRequest): Promise<PartnerMoviePage> {
    void req;
    return Promise.reject(soonError());
  }

  getMovie(id: string): Promise<PartnerMovie | null> {
    void id;
    return Promise.reject(soonError());
  }

  signedInLink(
    person: PartnerPerson,
    target: PartnerLinkTarget,
  ): Promise<PartnerLink> {
    void [person, target];
    return Promise.reject(soonError());
  }
}

function soonError(): MoviePartnerError {
  return new MoviePartnerError('off', 'Movies are not live yet.');
}
