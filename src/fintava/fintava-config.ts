import type { FintavaEnvironment } from './fintava.interface';

/** Fintava's sandbox. The default when FINTAVA_BASE_URL is not set. */
export const FINTAVA_SANDBOX_BASE_URL = 'https://dev.fintavapay.com/api/dev';

/**
 * The hosts the API key may be sent to. Live is never a default: it is used
 * only when FINTAVA_BASE_URL names it. Any other host is refused, so a typo
 * in config cannot send the key somewhere else. `local` is for a test double
 * on this machine, the only place plain http is allowed.
 */
const HOSTS: Record<string, FintavaEnvironment> = {
  'dev.fintavapay.com': 'sandbox',
  'live.fintavapay.com': 'live',
};
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

export const FINTAVA_CONFIG_KEYS = {
  baseUrl: 'FINTAVA_BASE_URL',
  apiKey: 'FINTAVA_API_KEY',
  readTimeoutMs: 'FINTAVA_TIMEOUT_MS',
  moneyTimeoutMs: 'FINTAVA_MONEY_TIMEOUT_MS',
  checkTimeoutMs: 'FINTAVA_CHECK_TIMEOUT_MS',
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
}

/** A Fintava setting that is present but wrong. Stops the app at boot. */
export class FintavaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FintavaConfigError';
  }
}

function timeout(raw: string | undefined, key: string, fallback: number) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 50 || n > 300_000) {
    throw new FintavaConfigError(
      `${key} must be a whole number of milliseconds from 50 to 300000.`,
    );
  }
  return n;
}

/**
 * Reads the Fintava settings. FINTAVA_BASE_URL unset means the sandbox,
 * except in production, where it must be set (live is never assumed).
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
    environment = HOSTS[url.hostname];
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
  };
}
