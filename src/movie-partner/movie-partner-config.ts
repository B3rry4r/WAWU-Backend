import {
  MOVIE_PARTNER_NAMES,
  type MoviePartnerName,
} from './movie-partner.interface';

/** Which movie partner the Hub talks to: one setting, read at boot (FLIX-01). Unset, blank or `off` is off. */
export const MOVIE_PARTNER_CONFIG_KEY = 'MOVIE_PARTNER';

export const DEFAULT_MOVIE_PARTNER: MoviePartnerName = 'off';

/** A MOVIE_PARTNER value the server cannot start with. Stops the app at boot. */
export class MoviePartnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoviePartnerConfigError';
  }
}

export function readMoviePartnerName(
  raw: string | undefined | null,
): MoviePartnerName {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return DEFAULT_MOVIE_PARTNER;
  const name = MOVIE_PARTNER_NAMES.find((n) => n === value);
  if (!name) {
    throw new MoviePartnerConfigError(
      `${MOVIE_PARTNER_CONFIG_KEY} must be one of: ${MOVIE_PARTNER_NAMES.join(', ')} (unset means ${DEFAULT_MOVIE_PARTNER}).`,
    );
  }
  return name;
}

/**
 * Picks the adapter for the configured partner. A partner with no adapter yet
 * stops the server rather than run movies on nothing (`flixora` is FLIX-02).
 */
export function selectMovieAdapter<T>(
  name: MoviePartnerName,
  adapters: Partial<Record<MoviePartnerName, () => T>>,
): T {
  const build = adapters[name];
  if (!build) {
    throw new MoviePartnerConfigError(
      `${MOVIE_PARTNER_CONFIG_KEY}=${name} is reserved: the ${name} adapter is not built yet. ` +
        `Set ${MOVIE_PARTNER_CONFIG_KEY}=${DEFAULT_MOVIE_PARTNER} (or leave it unset) and restart.`,
    );
  }
  return build();
}
