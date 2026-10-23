/**
 * What the movie routes answer (FLIX-01, R-74, Flow MV). Every field is the
 * partner's, read from the Hub's own copy of the catalog (never from a
 * design's sample). Dates are ISO 8601 strings.
 */

/** A trailer and how to play it (G-FLIX-3): a `file` plays in the app, a `youtube` one opens in YouTube or the browser. */
export interface MovieTrailerView {
  kind: 'file' | 'youtube';
  url: string;
}

/** One title as a rail card or a browse row. */
export interface MovieCardView {
  /** The id every movie route takes. */
  id: string;
  title: string;
  genre: string[];
  language: string | null;
  year: number | null;
  runtimeMinutes: number | null;
  /** G, PG, PG-13, PG-16, PG-18, R or NC-17; null when the partner gives none. */
  ageRating: string | null;
  posterImage: string | null;
  backdropImage: string | null;
  /** Average viewer rating on the partner's site. */
  rating: number;
  ratingCount: number;
  /** Plays on the partner's site. */
  views: number;
  /** True while the title has a premiere still ahead: until then only the trailer exists. */
  premiering: boolean;
  premierDate: string | null;
  addedAt: string;
}

export interface MovieCastView {
  name: string;
  character: string | null;
}

/** `GET /movies/{movieId}` (MV3, MV4). */
export interface MovieDetailView extends MovieCardView {
  originalTitle: string | null;
  synopsis: string;
  tagline: string | null;
  countryOfOrigin: string | null;
  cast: MovieCastView[];
  /** Null when the partner has no trailer for the title. */
  trailer: MovieTrailerView | null;
  /**
   * True when this person must tick the agreement before the first link
   * (R-75): they signed up before `FLIXORA_TERMS_FROM`, or that setting is
   * empty, and have not agreed since. `POST /movies/{movieId}/watch` then
   * answers `409 terms_not_agreed` until it carries `agreeToTerms: true`.
   */
  mustAgreeTerms: boolean;
}

export type MovieRailKey =
  'new' | 'most_watched' | 'top_rated' | 'premiering_soon';

/** A row of titles on Home or Explore. Empty rails are left out. */
export interface MovieRailView {
  key: MovieRailKey;
  title: string;
  movies: MovieCardView[];
}

/**
 * `GET /movies`. Off: `{ enabled: false, hero: null, rails: [] }`. Soon
 * (`MOVIE_PARTNER=soon`, R-77): `{ enabled: false, soon: true, hero: null,
 * rails: [] }`.
 */
export interface MoviesHomeView {
  enabled: boolean;
  /** True only when movies are switched to "not live yet" (R-77); absent or false otherwise. */
  soon?: boolean;
  /** The title shown large at the top of the movies screen; null when the catalog is empty. */
  hero: MovieCardView | null;
  rails: MovieRailView[];
}

/** `GET /movies/filters`: only what the catalog holds now. */
export interface MovieFiltersView {
  genres: string[];
  languages: string[];
}

/** `POST /movies/{movieId}/watch`: a link for this tap only. Never stored, never logged. */
export interface MovieWatchView {
  url: string;
  expiresAt: string;
}
