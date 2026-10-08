/**
 * Nuvion's settings (task NUV-01), read when WALLET_PROVIDER=nuvion picks the
 * Nuvion adapter, and only then: a server on Fintava never reads them, so a
 * missing or wrong Nuvion value cannot stop it. Every fact here is from
 * Nuvion's own docs (the lead's scratchpad `nuvion/docs/`:
 * `authentication.md`, `versioning.md`, `webhooks__overview.md`).
 *
 * Under nuvion a missing setting, or a base URL other than Nuvion's two
 * documented hosts, stops the server at boot with a message that names the
 * setting. The key is sent only to the host named here.
 */

/** Nuvion's sandbox and production hosts (authentication.md, "API keys"). */
export const NUVION_SANDBOX_BASE_URL = 'https://api.nuvion.dev';
export const NUVION_PRODUCTION_BASE_URL = 'https://api.nuvion.co';

/**
 * The API version every request pins (versioning.md: "Pin to a specific
 * version in production"). Nuvion's current version when this was built.
 */
export const NUVION_API_VERSION = '2026-02-06';

export const NUVION_CONFIG_KEYS = {
  baseUrl: 'NUVION_BASE_URL',
  apiKey: 'NUVION_API_KEY',
  apiVersion: 'NUVION_API_VERSION',
  /**
   * The webhook endpoint's secret, shown once by Nuvion when the endpoint is
   * registered (`POST /entity-webhooks`): the HMAC-SHA256 key of
   * `x-nuvion-event-signature`. Read on every delivery, under any
   * WALLET_PROVIDER; unset means every delivery is refused (401).
   */
  webhookSecret: 'NUVION_WEBHOOK_SECRET',
  /**
   * WAWU's own `operational` account on its parent entity at Nuvion, through
   * which held money moves (R-42). NUV-05 reads its balance and moves money
   * through it.
   */
  operationalAccountId: 'NUVION_OPERATIONAL_ACCOUNT_ID',
  readTimeoutMs: 'NUVION_TIMEOUT_MS',
  moneyTimeoutMs: 'NUVION_MONEY_TIMEOUT_MS',
  checkTimeoutMs: 'NUVION_CHECK_TIMEOUT_MS',
  resendSafetyMs: 'NUVION_RESEND_SAFETY_MS',
} as const;

/** The settings without which the Nuvion adapter cannot start. */
export const NUVION_REQUIRED_KEYS = [
  NUVION_CONFIG_KEYS.baseUrl,
  NUVION_CONFIG_KEYS.apiKey,
  NUVION_CONFIG_KEYS.webhookSecret,
  NUVION_CONFIG_KEYS.operationalAccountId,
] as const;

/**
 * PROVISIONAL(NUVION-TIMEOUTS, owner=YOU, why=Nuvion publishes no timeout or retry guidance and its sandbox key has not answered yet; Fintava's sandbox-measured values are the starting point)
 *
 * How long the client waits for Nuvion, in milliseconds, and how long the
 * app is told to wait before trying a refused read again. Each is
 * overridable in config (NUVION_TIMEOUT_MS, NUVION_MONEY_TIMEOUT_MS,
 * NUVION_CHECK_TIMEOUT_MS).
 */
export const NUVION_DEFAULTS = {
  readTimeoutMs: 15_000,
  moneyTimeoutMs: 30_000,
  checkTimeoutMs: 30_000,
  retryAfterSeconds: 30,
} as const;

/**
 * PROVISIONAL(NUVION-RESEND-SAFETY, owner=YOU, why=Nuvion does not say how long a transfer it accepted can take to show; the same ten minutes as Fintava)
 *
 * How long after the money timeout a send whose answer was lost must stay
 * untouched before Nuvion saying it has no such send may lead to sending it
 * again. NUVION_RESEND_SAFETY_MS overrides it.
 */
export const NUVION_RESEND_SAFETY_MS = 10 * 60_000;

/**
 * PROVISIONAL(NUVION-WEBHOOK-WINDOW, owner=YOU, why=Nuvion's docs state no replay window for signed deliveries; five minutes either side of our clock)
 *
 * A delivery whose `x-nuvion-event-timestamp` is further than this from our
 * clock, before or after, is refused (401) and not stored: a captured
 * delivery cannot be replayed later. Nuvion retries a refused delivery for
 * up to 15 minutes with fresh attempts.
 */
export const NUVION_WEBHOOK_WINDOW_MS = 5 * 60_000;

/** Everything the client needs except the key, which is kept apart. */
export interface NuvionSettings {
  baseUrl: string;
  environment: 'sandbox' | 'production' | 'standin';
  apiVersion: string;
  operationalAccountId: string;
  /** Reads: lists, balances, lookups, statements, bank codes. */
  readTimeoutMs: number;
  /** Anything that moves money or creates something at Nuvion. */
  moneyTimeoutMs: number;
  /** Identity and document checks. */
  checkTimeoutMs: number;
  /** Added to `moneyTimeoutMs` before a lost send may be sent again. */
  resendSafetyMs: number;
  retryAfterSeconds: number;
}

/** A Nuvion setting that is missing or wrong under nuvion. Stops the app at boot. */
export class NuvionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NuvionConfigError';
  }
}

function timeout(
  raw: string | undefined,
  key: string,
  fallback: number,
  range: [number, number] = [50, 300_000],
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < range[0] || n > range[1]) {
    throw new NuvionConfigError(
      `${key} must be a whole number of milliseconds from ${range[0]} to ${range[1]}.`,
    );
  }
  return n;
}

/** Nuvion ids are ULIDs; this only refuses what cannot be an id. */
const ID = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * Reads and checks the Nuvion settings. Called only when WALLET_PROVIDER is
 * nuvion. Throws NuvionConfigError naming the first setting that is missing
 * or wrong, in NUVION_REQUIRED_KEYS order, then the optional ones.
 */
export function readNuvionSettings(get: (key: string) => string | undefined): {
  settings: NuvionSettings;
  apiKey: string;
} {
  const value = (key: string) => (get(key) ?? '').trim();
  for (const key of NUVION_REQUIRED_KEYS) {
    if (value(key) === '') {
      throw new NuvionConfigError(
        `${key} must be set when WALLET_PROVIDER=nuvion. Set it, or set WALLET_PROVIDER=fintava and restart to roll back.`,
      );
    }
  }

  const base = value(NUVION_CONFIG_KEYS.baseUrl).replace(/\/+$/, '');
  // Exact string comparison: only Nuvion's two documented hosts, https, no
  // path, port, query or credentials. A typo cannot send the key elsewhere.
  let environment: NuvionSettings['environment'];
  if (base === NUVION_SANDBOX_BASE_URL) environment = 'sandbox';
  else if (base === NUVION_PRODUCTION_BASE_URL) environment = 'production';
  else {
    throw new NuvionConfigError(
      `${NUVION_CONFIG_KEYS.baseUrl} must be ${NUVION_SANDBOX_BASE_URL} or ${NUVION_PRODUCTION_BASE_URL}.`,
    );
  }

  const version = value(NUVION_CONFIG_KEYS.apiVersion);
  if (version !== '' && version !== NUVION_API_VERSION) {
    throw new NuvionConfigError(
      `${NUVION_CONFIG_KEYS.apiVersion} is pinned to ${NUVION_API_VERSION}; leave it empty or set exactly that.`,
    );
  }

  const operational = value(NUVION_CONFIG_KEYS.operationalAccountId);
  if (!ID.test(operational)) {
    throw new NuvionConfigError(
      `${NUVION_CONFIG_KEYS.operationalAccountId} must be the id of WAWU's operational account at Nuvion.`,
    );
  }

  const settings: NuvionSettings = {
    baseUrl: base,
    environment,
    apiVersion: NUVION_API_VERSION,
    operationalAccountId: operational,
    readTimeoutMs: timeout(
      get(NUVION_CONFIG_KEYS.readTimeoutMs),
      NUVION_CONFIG_KEYS.readTimeoutMs,
      NUVION_DEFAULTS.readTimeoutMs,
    ),
    moneyTimeoutMs: timeout(
      get(NUVION_CONFIG_KEYS.moneyTimeoutMs),
      NUVION_CONFIG_KEYS.moneyTimeoutMs,
      NUVION_DEFAULTS.moneyTimeoutMs,
    ),
    checkTimeoutMs: timeout(
      get(NUVION_CONFIG_KEYS.checkTimeoutMs),
      NUVION_CONFIG_KEYS.checkTimeoutMs,
      NUVION_DEFAULTS.checkTimeoutMs,
    ),
    resendSafetyMs: timeout(
      get(NUVION_CONFIG_KEYS.resendSafetyMs),
      NUVION_CONFIG_KEYS.resendSafetyMs,
      NUVION_RESEND_SAFETY_MS,
      [60_000, 86_400_000],
    ),
    retryAfterSeconds: NUVION_DEFAULTS.retryAfterSeconds,
  };
  return { settings, apiKey: value(NUVION_CONFIG_KEYS.apiKey) };
}
