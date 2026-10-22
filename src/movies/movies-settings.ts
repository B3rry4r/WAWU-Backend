import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/**
 * The movie settings (FLIX-01), read from the environment each time they are
 * used, so a restart is the only step to change one. None is a secret.
 */
export const FLIXORA_TERMS_FROM_KEY = 'FLIXORA_TERMS_FROM';
export const MOVIE_SYNC_INTERVAL_KEY = 'MOVIE_SYNC_INTERVAL_MINUTES';
export const MOVIE_SYNC_FULL_EVERY_KEY = 'MOVIE_SYNC_FULL_EVERY_HOURS';
export const MOVIE_SYNC_PAGE_SIZE_KEY = 'MOVIE_SYNC_PAGE_SIZE';
export const MOVIE_SYNC_MAX_PAGES_KEY = 'MOVIE_SYNC_MAX_PAGES';

/** PROVISIONAL(owner): how often the catalog copy is refreshed. One request per pass when nothing changed. */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
/** PROVISIONAL(owner): how often a full pass also removes titles the partner dropped. */
export const DEFAULT_SYNC_FULL_EVERY_HOURS = 24;
export const DEFAULT_SYNC_PAGE_SIZE = 100;
/** A pass stops after this many pages, so a runaway answer cannot spend the partner's request limit. */
export const DEFAULT_SYNC_MAX_PAGES = 100;

const logger = new Logger('MoviesSettings');
let warnedTermsFrom: string | null = null;

/**
 * When the updated terms that name the movie partner went live (R-75). Empty
 * or not a date: null, and nobody counts as having agreed at sign-up (the
 * safe direction: more people see the agreement box, none skips it).
 */
export function readTermsFrom(config: ConfigService): Date | null {
  const raw = (config.get<string>(FLIXORA_TERMS_FROM_KEY) ?? '').trim();
  if (raw === '') return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    if (warnedTermsFrom !== raw) {
      warnedTermsFrom = raw;
      logger.warn(
        `${FLIXORA_TERMS_FROM_KEY} is not a date, so nobody counts as having agreed at sign-up.`,
      );
    }
    return null;
  }
  return at;
}

export function readPositiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = (config.get<string>(key) ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
}
