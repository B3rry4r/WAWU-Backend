/**
 * THE ONE SEAM TO THE MOVIE PARTNER (FLIX-01, R-75), shaped on
 * docs/flixora/PARTNER-API.md in the mobile repo.
 *
 * Everything outside the adapters reaches the partner only through
 * `MOVIE_PARTNER`; nothing else imports `src/flixora/` (FLIX-02, the real
 * adapter) or the stand-in. `MOVIE_PARTNER` picks the adapter at boot: `off`
 * (the default; empty is off), `standin` (made-up titles, no network),
 * `flixora` (FLIX-02) and `soon` (FLIX-04, R-77: movies stay visible as "not
 * live yet" and do nothing; no adapter, no sync, no call). Turning it `off`
 * or `soon` stops every call and every link; the Hub's copy of the catalog
 * stays.
 */
export const MOVIE_PARTNER = Symbol('MOVIE_PARTNER');

export const MOVIE_PARTNER_NAMES = [
  'off',
  'standin',
  'flixora',
  'soon',
] as const;
export type MoviePartnerName = (typeof MOVIE_PARTNER_NAMES)[number];

/** A person in the cast, as the partner lists them. */
export interface PartnerCastMember {
  name: string;
  character: string | null;
}

/**
 * One title, field for field as the partner's movie object (PARTNER-API.md
 * "Movie object"). Dates are ISO 8601 strings.
 */
export interface PartnerMovie {
  id: string;
  title: string;
  originalTitle: string | null;
  synopsis: string;
  tagline: string | null;
  genre: string[];
  language: string | null;
  countryOfOrigin: string | null;
  year: number | null;
  runtimeMinutes: number | null;
  ageRating: string | null;
  posterImage: string | null;
  backdropImage: string | null;
  /** A video file OR a YouTube link. */
  trailerUrl: string | null;
  cast: PartnerCastMember[];
  rating: number;
  ratingCount: number;
  views: number;
  premiering: boolean;
  premierDate: string | null;
  addedAt: string;
  /** The title's path on the partner's site; the `redirect` of a signed-in link. */
  flixoraPath: string;
  flixoraUrl: string;
}

export interface ListMoviesRequest {
  /** From 1. */
  page: number;
  /** 1 to 100. */
  limit: number;
  /** Only titles changed since then (the incremental sync). */
  updatedSince?: Date;
}

export interface PartnerMoviePage {
  movies: PartnerMovie[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
}

/**
 * The ONLY facts about a person the seam is given (R-75): their permanent
 * WAWU id, email, first and last name, and whether WAWU verified the email.
 * Never a phone, BVN, NIN, ID document or anything about a wallet. A spec
 * checks every call's argument against exactly these keys.
 */
export interface PartnerPerson {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
}

/** The title a link opens. */
export interface PartnerLinkTarget {
  id: string;
  /** The movie's `flixoraPath`. */
  path: string;
}

/**
 * A link for ONE tap. It carries a one-time token, so it is never stored and
 * never logged by anything that holds it.
 */
export interface PartnerLink {
  url: string;
  expiresAt: Date;
}

/**
 * Why the partner did not answer. `unavailable`: it did not answer or answered
 * with a fault (trying again may work). `rejected`: it refused (a bad key, an
 * account not approved). `off`: the adapter is `off` and was asked anyway.
 * The message never holds a response body, a link or a token.
 */
export class MoviePartnerError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'rejected' | 'off',
    message: string,
  ) {
    super(message);
    this.name = 'MoviePartnerError';
  }
}

export interface MoviePartner {
  readonly name: MoviePartnerName;
  /** False for `off` and `soon`: no catalog is shown, nothing is called or linked. */
  readonly enabled: boolean;
  /** True only for `soon` (R-77): the app still shows Flix movies, as "not live yet". */
  readonly soon?: boolean;
  /**
   * A page of the partner's catalog, newest first. A network call: the caller
   * holds no transaction, connection or lock while it runs. Throws
   * `MoviePartnerError`.
   */
  listMovies(req: ListMoviesRequest): Promise<PartnerMoviePage>;
  /** One title, or null when the partner has none by that id. */
  getMovie(id: string): Promise<PartnerMovie | null>;
  /**
   * A fresh signed-in link for one person to one title. The first one a person
   * follows opens their account on the partner's side. Same rules as
   * `listMovies`.
   */
  signedInLink(
    person: PartnerPerson,
    target: PartnerLinkTarget,
  ): Promise<PartnerLink>;
}
