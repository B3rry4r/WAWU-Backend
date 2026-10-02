import type { FintavaEnvironment } from './fintava.interface';

/** Fintava's sandbox. The default when FINTAVA_BASE_URL is not set. */
export const FINTAVA_SANDBOX_BASE_URL = 'https://dev.fintavapay.com/api/dev';

/**
 * The hosts the API key may be sent to. Live is never a default: it is used
 * only when FINTAVA_BASE_URL names it. Any other host is refused, so a typo
 * in config cannot send the key somewhere else. `local` is for a test double
 * on this machine, the only place plain http is allowed.
 */
const SANDBOX_HOST = 'dev.fintavapay.com';
const LIVE_HOST = 'live.fintavapay.com';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * PROVISIONAL(FINTAVA-TIMEOUTS, owner=YOU, why=Fintava publishes no timeout or retry guidance; sandbox answers took 0.2 to 5.5 s)
 *
 * How long the client waits for Fintava before giving up, in milliseconds,
 * and how long the app is told to wait before trying a read again. Reads
 * answered in 0.2 to 1.5 s in the sandbox; money moves in about 0.6 s; the
 * BVN and selfie checks, which call a provider upstream, in 2.6 to 5.5 s
 * (mobile repo `docs/fintava/sandbox/`). Each is overridable in config.
 */
export const FINTAVA_DEFAULTS = {
  readTimeoutMs: 15_000,
  moneyTimeoutMs: 30_000,
  checkTimeoutMs: 30_000,
  retryAfterSeconds: 30,
} as const;

/**
 * PROVISIONAL(FINTAVA-RESEND-SAFETY, owner=YOU, why=Fintava says nothing on how long a send it accepted can take to show; a send abandoned at 3 s landed)
 *
 * How long after the money timeout a send whose answer was lost must stay
 * untouched before Fintava saying it has no such send (a 404 by reference,
 * and no row in history) may lead to sending it again. Fintava keeps
 * working after the client gives up (mobile repo
 * `docs/fintava/sandbox/26-money06-client.md`). Ten minutes is also past
 * the about-5-minute cache on the merchant history.
 */
export const FINTAVA_RESEND_SAFETY_MS = 10 * 60_000;

export const FINTAVA_CONFIG_KEYS = {
  baseUrl: 'FINTAVA_BASE_URL',
  apiKey: 'FINTAVA_API_KEY',
  readTimeoutMs: 'FINTAVA_TIMEOUT_MS',
  moneyTimeoutMs: 'FINTAVA_MONEY_TIMEOUT_MS',
  checkTimeoutMs: 'FINTAVA_CHECK_TIMEOUT_MS',
  resendSafetyMs: 'FINTAVA_RESEND_SAFETY_MS',
} as const;

/** Everything the client needs except the key, which is kept apart. */
export interface FintavaSettings {
  baseUrl: string;
  environment: FintavaEnvironment;
  /** Reads: lists, balances, lookups, history, name checks. */
  readTimeoutMs: number;
  /** Anything that moves money, opens an account or freezes a wallet. */
  moneyTimeoutMs: number;
  /** The BVN, selfie and phone checks (an upstream provider is called). */
  checkTimeoutMs: number;
  /**
   * Added to `moneyTimeoutMs`: a lost send is never sent again sooner than
   * both after it was first sent.
   */
  resendSafetyMs: number;
}

/** A Fintava setting that is present but wrong. Stops the app at boot. */
export class FintavaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FintavaConfigError';
  }
}

function timeout(
  raw: string | undefined,
  key: string,
  fallback: number,
  range: [number, number] = [50, 300_000],
) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < range[0] || n > range[1]) {
    throw new FintavaConfigError(
      `${key} must be a whole number of milliseconds from ${range[0]} to ${range[1]}.`,
    );
  }
  return n;
}

/**
 * True in production when FINTAVA_BASE_URL is not set (or blank): Fintava is
 * simply not set up on this server yet (OPS-10 adds it). The client is then
 * built unconfigured instead of stopping the app (MONEY-11): the rest of the
 * backend must keep starting on every deploy, and the wallet routes answer
 * 503 until the setting arrives. A value that IS set is still read, and
 * refused when wrong, by readFintavaSettings below.
 */
export function fintavaIsUnconfigured(
  get: (key: string) => string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return (
    (get(FINTAVA_CONFIG_KEYS.baseUrl)?.trim() ?? '') === '' &&
    nodeEnv === 'production'
  );
}

/** The settings of a client that sends nothing: no base URL, no host. */
export function unconfiguredFintavaSettings(): FintavaSettings {
  return {
    baseUrl: '',
    environment: 'unconfigured',
    readTimeoutMs: FINTAVA_DEFAULTS.readTimeoutMs,
    moneyTimeoutMs: FINTAVA_DEFAULTS.moneyTimeoutMs,
    checkTimeoutMs: FINTAVA_DEFAULTS.checkTimeoutMs,
    resendSafetyMs: FINTAVA_RESEND_SAFETY_MS,
  };
}

/**
 * Reads the Fintava settings. FINTAVA_BASE_URL unset means the sandbox,
 * except in production, where it must be set (live is never assumed; the
 * client checks fintavaIsUnconfigured first and does not call this then).
 */
export function readFintavaSettings(
  get: (key: string) => string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): FintavaSettings {
  const rawBase = get(FINTAVA_CONFIG_KEYS.baseUrl)?.trim() ?? '';
  if (rawBase === '' && nodeEnv === 'production') {
    throw new FintavaConfigError(
      `${FINTAVA_CONFIG_KEYS.baseUrl} must be set in production.`,
    );
  }
  const base = rawBase === '' ? FINTAVA_SANDBOX_BASE_URL : rawBase;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new FintavaConfigError(
      `${FINTAVA_CONFIG_KEYS.baseUrl} is not a URL.`,
    );
  }
  let environment: FintavaEnvironment | undefined;
  if (LOCAL_HOSTS.has(url.hostname)) {
    if (nodeEnv === 'production') {
      throw new FintavaConfigError(
        `${FINTAVA_CONFIG_KEYS.baseUrl} cannot point at this machine in production.`,
      );
    }
    environment = 'local';
  } else if (url.protocol === 'https:') {
    // Exact string comparison, never a lookup in an object: an object would
    // also answer for `constructor`, `__proto__` and the like.
    if (url.hostname === SANDBOX_HOST) environment = 'sandbox';
    else if (url.hostname === LIVE_HOST) environment = 'live';
  }
  if (!environment) {
    throw new FintavaConfigError(
      `${FINTAVA_CONFIG_KEYS.baseUrl} must be https://dev.fintavapay.com or https://live.fintavapay.com.`,
    );
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new FintavaConfigError(
      `${FINTAVA_CONFIG_KEYS.baseUrl} must be a plain base URL.`,
    );
  }

  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    environment,
    readTimeoutMs: timeout(
      get(FINTAVA_CONFIG_KEYS.readTimeoutMs),
      FINTAVA_CONFIG_KEYS.readTimeoutMs,
      FINTAVA_DEFAULTS.readTimeoutMs,
    ),
    moneyTimeoutMs: timeout(
      get(FINTAVA_CONFIG_KEYS.moneyTimeoutMs),
      FINTAVA_CONFIG_KEYS.moneyTimeoutMs,
      FINTAVA_DEFAULTS.moneyTimeoutMs,
    ),
    checkTimeoutMs: timeout(
      get(FINTAVA_CONFIG_KEYS.checkTimeoutMs),
      FINTAVA_CONFIG_KEYS.checkTimeoutMs,
      FINTAVA_DEFAULTS.checkTimeoutMs,
    ),
    resendSafetyMs: timeout(
      get(FINTAVA_CONFIG_KEYS.resendSafetyMs),
      FINTAVA_CONFIG_KEYS.resendSafetyMs,
      FINTAVA_RESEND_SAFETY_MS,
      [60_000, 86_400_000],
    ),
  };
}
