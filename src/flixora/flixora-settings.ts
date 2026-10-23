/**
 * The Flixora settings (FLIX-02, R-74, R-75), read once at boot when
 * `MOVIE_PARTNER=flixora`. A missing or unusable one stops the server and the
 * message names the setting, never its value: the key and the sign-in secret
 * are secrets and never appear in a message, a log or a spec.
 */
export const FLIXORA_API_BASE_URL_KEY = 'FLIXORA_API_BASE_URL';
export const FLIXORA_API_KEY_KEY = 'FLIXORA_API_KEY';
export const FLIXORA_SSO_SECRET_KEY = 'FLIXORA_SSO_SECRET';
export const FLIXORA_PARTNER_SLUG_KEY = 'FLIXORA_PARTNER_SLUG';
export const FLIXORA_SITE_URL_KEY = 'FLIXORA_SITE_URL';
export const FLIXORA_REGION_KEY = 'FLIXORA_REGION';

/** The settings that have no default: each one missing stops a `flixora` server. */
export const FLIXORA_REQUIRED_KEYS = [
  FLIXORA_API_BASE_URL_KEY,
  FLIXORA_API_KEY_KEY,
  FLIXORA_SSO_SECRET_KEY,
  FLIXORA_PARTNER_SLUG_KEY,
  FLIXORA_SITE_URL_KEY,
] as const;

export const FLIXORA_REGIONS = ['NG', 'UK', 'US'] as const;
export type FlixoraRegion = (typeof FLIXORA_REGIONS)[number];
/** Nigeria is where the app launches (the docs' `region` filter). */
export const DEFAULT_FLIXORA_REGION: FlixoraRegion = 'NG';

export type FlixoraEnvironment = 'test' | 'live';

export interface FlixoraSettings {
  /** No trailing slash, for example `https://host/api/partners`. */
  apiBaseUrl: string;
  apiKey: string;
  ssoSecret: string;
  partnerSlug: string;
  /** No trailing slash, for example `https://www.flixora.com`. */
  siteUrl: string;
  region: FlixoraRegion;
}

/** A Flixora setting the server cannot start with. Stops the app at boot. */
export class FlixoraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlixoraConfigError';
  }
}

/** Which environment a key belongs to, from its prefix; null for anything else. */
export function environmentOfKey(key: string): FlixoraEnvironment | null {
  if (key.startsWith('flx_test_')) return 'test';
  if (key.startsWith('flx_live_')) return 'live';
  return null;
}

function webAddress(
  name: string,
  raw: string,
  problems: string[],
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be a web address.`);
    return null;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    problems.push(`${name} must start with https://.`);
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    problems.push(`${name} must not hold a user name or password.`);
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Reads and checks the six settings. Missing ones are listed together, so one
 * restart is enough to fix them all.
 */
export function readFlixoraSettings(
  get: (key: string) => string | undefined,
): FlixoraSettings {
  const value = (key: string): string => (get(key) ?? '').trim();
  const missing = FLIXORA_REQUIRED_KEYS.filter((key) => value(key) === '');
  if (missing.length > 0) {
    throw new FlixoraConfigError(
      `MOVIE_PARTNER=flixora needs ${missing.join(', ')}. Set ${missing.length === 1 ? 'it' : 'them'} and restart, or set MOVIE_PARTNER=off.`,
    );
  }

  const problems: string[] = [];
  const apiBaseUrl = webAddress(
    FLIXORA_API_BASE_URL_KEY,
    value(FLIXORA_API_BASE_URL_KEY),
    problems,
  );
  const siteUrl = webAddress(
    FLIXORA_SITE_URL_KEY,
    value(FLIXORA_SITE_URL_KEY),
    problems,
  );
  const apiKey = value(FLIXORA_API_KEY_KEY);
  if (environmentOfKey(apiKey) === null) {
    problems.push(
      `${FLIXORA_API_KEY_KEY} must be a Flixora key (it starts with flx_test_ or flx_live_).`,
    );
  }
  const slug = value(FLIXORA_PARTNER_SLUG_KEY);
  if (/[\s/?#\\]/.test(slug)) {
    problems.push(
      `${FLIXORA_PARTNER_SLUG_KEY} must be the partner slug only, with no spaces, slashes or other punctuation of a web address.`,
    );
  }
  const regionRaw = value(FLIXORA_REGION_KEY).toUpperCase();
  const region = regionRaw === '' ? DEFAULT_FLIXORA_REGION : regionRaw;
  if (!(FLIXORA_REGIONS as readonly string[]).includes(region)) {
    problems.push(
      `${FLIXORA_REGION_KEY} must be one of: ${FLIXORA_REGIONS.join(', ')} (unset means ${DEFAULT_FLIXORA_REGION}).`,
    );
  }
  if (problems.length > 0 || apiBaseUrl === null || siteUrl === null) {
    throw new FlixoraConfigError(problems.join(' '));
  }
  return {
    apiBaseUrl,
    apiKey,
    ssoSecret: value(FLIXORA_SSO_SECRET_KEY),
    partnerSlug: slug,
    siteUrl,
    region: region as FlixoraRegion,
  };
}
