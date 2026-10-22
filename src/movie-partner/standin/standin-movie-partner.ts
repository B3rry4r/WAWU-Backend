import { randomBytes } from 'node:crypto';
import {
  MoviePartnerError,
  type ListMoviesRequest,
  type MoviePartner,
  type PartnerLink,
  type PartnerLinkTarget,
  type PartnerMovie,
  type PartnerMoviePage,
  type PartnerPerson,
} from '../movie-partner.interface';
import { standinMovies } from './standin-titles';

/** A link made by the stand-in lives this long, like the partner's own (a minute is plenty). */
export const STANDIN_LINK_SECONDS = 60;

interface Held {
  movie: PartnerMovie;
  /** When the stand-in last "changed" the title; what `updatedSince` compares. */
  updatedAt: Date;
}

/**
 * The stand-in movie partner (FLIX-01; `MOVIE_PARTNER=standin`): made-up
 * titles held in memory, shaped on docs/flixora/PARTNER-API.md (a page of
 * movies newest first with `updatedSince`, one movie, and a signed-in link
 * whose token sits after `#`). No network, no key. Each link gets a new random
 * token, like the real one's one-time `jti`.
 *
 * `setMovie` and `removeMovie` change the catalog the way the partner would,
 * so the sync can be tried against changes and removals.
 */
export class StandinMoviePartner implements MoviePartner {
  readonly name = 'standin' as const;
  readonly enabled = true;

  private readonly held = new Map<string, Held>();
  /** When true every call answers `unavailable`, to try the partner being down. */
  down = false;
  /** Every call, by method name; never holds a person or a link. */
  readonly calls: string[] = [];

  constructor(now: Date = new Date()) {
    for (const movie of standinMovies(now))
      this.held.set(movie.id, { movie, updatedAt: new Date(0) });
  }

  setMovie(movie: PartnerMovie, changedAt: Date = new Date()): void {
    this.held.set(movie.id, { movie, updatedAt: changedAt });
  }

  removeMovie(id: string): void {
    this.held.delete(id);
  }

  listMovies(req: ListMoviesRequest): Promise<PartnerMoviePage> {
    this.calls.push('listMovies');
    if (this.down) return Promise.reject(unavailable());
    const all = [...this.held.values()]
      .filter(
        (h) =>
          !req.updatedSince ||
          h.updatedAt.getTime() > req.updatedSince.getTime(),
      )
      .map((h) => h.movie)
      .sort(
        (a, b) =>
          b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id),
      );
    const totalPages = Math.max(1, Math.ceil(all.length / req.limit));
    const start = (req.page - 1) * req.limit;
    return Promise.resolve({
      movies: all.slice(start, start + req.limit),
      total: all.length,
      page: req.page,
      limit: req.limit,
      totalPages,
      hasNextPage: req.page < totalPages,
    });
  }

  getMovie(id: string): Promise<PartnerMovie | null> {
    this.calls.push('getMovie');
    if (this.down) return Promise.reject(unavailable());
    return Promise.resolve(this.held.get(id)?.movie ?? null);
  }

  signedInLink(
    person: PartnerPerson,
    target: PartnerLinkTarget,
  ): Promise<PartnerLink> {
    this.calls.push('signedInLink');
    if (this.down) return Promise.reject(unavailable());
    if (!person.email) {
      return Promise.reject(
        new MoviePartnerError('rejected', 'The partner needs an email.'),
      );
    }
    const token = randomBytes(24).toString('base64url');
    return Promise.resolve({
      url: `https://flixora-standin.invalid/partner/wawu/login#token=${token}&redirect=${encodeURIComponent(target.path)}`,
      expiresAt: new Date(Date.now() + STANDIN_LINK_SECONDS * 1000),
    });
  }
}

function unavailable(): MoviePartnerError {
  return new MoviePartnerError(
    'unavailable',
    'The stand-in is switched to down.',
  );
}
