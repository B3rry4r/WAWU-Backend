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
 * The default (`MOVIE_PARTNER` unset, blank or `off`): movies are unplugged.
 * It reaches nothing and answers nothing. The Hub checks `enabled` before it
 * asks, so these throw only if something forgot to.
 */
export class OffMoviePartner implements MoviePartner {
  readonly name = 'off' as const;
  readonly enabled = false;

  listMovies(req: ListMoviesRequest): Promise<PartnerMoviePage> {
    void req;
    return Promise.reject(off());
  }

  getMovie(id: string): Promise<PartnerMovie | null> {
    void id;
    return Promise.reject(off());
  }

  signedInLink(
    person: PartnerPerson,
    target: PartnerLinkTarget,
  ): Promise<PartnerLink> {
    void [person, target];
    return Promise.reject(off());
  }
}

function off(): MoviePartnerError {
  return new MoviePartnerError('off', 'Movies are switched off.');
}
