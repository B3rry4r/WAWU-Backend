import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Settings for the BVN check (task KYC-01).
 *
 * IDENTITY_HASH_KEY is the server secret the BVN and NIN are hashed under.
 * A BVN or NIN is 11 digits: 10^11 values, so a plain or salted hash of one
 * can be reversed by trying them all, in minutes on one GPU. A keyed hash
 * (HMAC-SHA256) cannot be, without the key, which never leaves the server's
 * environment. Changing the key makes every stored hash stop matching:
 * people would have to run the BVN check again, so it is set once.
 */
export const IDENTITY_CONFIG_KEYS = {
  hashKey: 'IDENTITY_HASH_KEY',
  checksPerDay: 'BVN_CHECKS_PER_DAY',
  selfieChecksPerDay: 'SELFIE_CHECKS_PER_DAY',
} as const;

/** The shortest key accepted: 32 characters (`openssl rand -hex 32` gives 64). */
export const IDENTITY_HASH_KEY_MIN_LENGTH = 32;

/**
 * PROVISIONAL(BVN-CHECKS-PER-DAY, owner=YOU, why=Fintava charges for every BVN lookup, even a refused one, and no ruling names a limit)
 *
 * BVN checks one person may run in any 24 hours, counted from
 * BvnCheckAttempt (in the database, so it holds across restarts and
 * servers). Three covers a mistyped BVN and a retry after Fintava did not
 * answer, and caps what one account can cost at three charges a day
 * (₦5 each in the sandbox, `docs/fintava/sandbox/25-compliance-charges.md`
 * in the mobile repo). Overridable in config with BVN_CHECKS_PER_DAY.
 */
export const DEFAULT_BVN_CHECKS_PER_DAY = 3;

/** The window the daily limit counts over: a rolling 24 hours. */
export const BVN_CHECK_WINDOW_MS = 24 * 60 * 60_000;

/**
 * PROVISIONAL(SELFIE-CHECKS-PER-DAY, owner=YOU, why=Fintava charges for every selfie match, even a failed one; the ticket and fees.md name 3 a day, no ruling confirms it)
 *
 * Selfie matches (task KYC-02) one person may run in any 24 hours, counted
 * from SelfieMatchAttempt the same way as the BVN checks above. Each is
 * charged even when the faces do not match (₦10 in the sandbox,
 * `docs/fintava/sandbox/05-bvn-selfie.md` in the mobile repo), so this caps
 * what one account's retries can cost. Overridable with
 * SELFIE_CHECKS_PER_DAY.
 */
export const DEFAULT_SELFIE_CHECKS_PER_DAY = 3;

/**
 * PROVISIONAL(BVN-CHECK-BURST, owner=YOU, why=no ruling names a per-address limit for a charged identity lookup)
 *
 * The per-address limits the app's global ThrottlerGuard applies to
 * POST /money/identity/bvn and POST /money/identity/selfie (KYC-02; the
 * guard keeps a separate count per route), on the app's own named throttlers (`short` and
 * `medium`, app.module.ts): at most 3 a minute and 20 an hour from one
 * address. The per-person limit above is the one that bounds the cost; this
 * one stops one address from running checks for many fresh accounts at
 * once. Carrier NAT puts many people behind one address, hence 20, not 3.
 * The address is the caller's, not nginx's: see bvnCheckTracker.
 */
export const BVN_CHECK_THROTTLE = {
  short: { limit: 3, ttl: 60_000, getTracker: bvnCheckTracker },
  medium: { limit: 20, ttl: 60 * 60_000, getTracker: bvnCheckTracker },
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whose address a BVN check counts against. nginx proxies from the same
 * machine and appends the caller's address as the LAST entry of
 * X-Forwarded-For (`$proxy_add_x_forwarded_for`, deploy/install-services.sh),
 * so: from a loopback peer, that last entry; from anyone else, their own
 * address. Entries a caller writes themselves sit to the left of nginx's,
 * so they do not count, and a caller who reaches the app directly cannot use
 * the header at all.
 *
 * Since OPS-11 the app sets `trust proxy` to `hubTrustProxy`
 * (src/hub-app-options.ts): one hop, only from a loopback peer. `req.ip` is
 * then already that last entry for a loopback peer and the peer's own
 * address otherwise, so this returns `req.ip` in every case. It is kept so
 * the BVN limit stays per caller even if that setting is ever removed
 * (before it, `req.ip` was nginx's 127.0.0.1 for everyone: one bucket of 3 a
 * minute for the whole country).
 */
type TrackedRequest = {
  ip?: unknown;
  socket?: { remoteAddress?: unknown };
  headers?: Record<string, unknown>;
};

export function bvnCheckTracker(request: Record<string, unknown>): string {
  const req = request as TrackedRequest;
  const ip = req.ip ?? req.socket?.remoteAddress;
  const peer = typeof ip === 'string' ? ip : '';
  if (!LOOPBACK.has(peer)) return peer;
  const header = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string') return peer;
  const last = raw.split(',').pop()?.trim() ?? '';
  return last === '' ? peer : last;
}

/** A set but unusable identity setting. Stops the app at boot. */
export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigError';
  }
}

/** Reads a per-day limit (1 to 50); unset means the provisional default. */
function perDay(
  raw: string | undefined,
  key: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new IdentityConfigError(
      `${key} must be a whole number from 1 to 50.`,
    );
  }
  return n;
}

/** Reads BVN_CHECKS_PER_DAY; unset means the provisional default. */
export function bvnChecksPerDay(raw: string | undefined): number {
  return perDay(
    raw,
    IDENTITY_CONFIG_KEYS.checksPerDay,
    DEFAULT_BVN_CHECKS_PER_DAY,
  );
}

/** Reads SELFIE_CHECKS_PER_DAY; unset means the provisional default. */
export function selfieChecksPerDay(raw: string | undefined): number {
  return perDay(
    raw,
    IDENTITY_CONFIG_KEYS.selfieChecksPerDay,
    DEFAULT_SELFIE_CHECKS_PER_DAY,
  );
}

/**
 * The rows a per-person daily limit is counted from: one per charged
 * identity check (BvnCheckAttempt for the BVN, SelfieMatchAttempt for the
 * selfie). Each holds only an id, the person and when it was taken.
 */
export interface DailyAttemptLedger {
  /** Writes a new row for this person now; answers its id. */
  create(wawuUserId: string): Promise<string>;
  /** Rows for this person taken after `since`. */
  count(wawuUserId: string, since: Date): Promise<number>;
  remove(id: string): Promise<void>;
  /** When this person's oldest row after `since` was taken, or null. */
  oldestSince(wawuUserId: string, since: Date): Promise<Date | null>;
}

/**
 * Takes one of today's checks before Fintava is asked (KYC-01, used by the
 * BVN check and KYC-02's selfie match alike). The row is written first and
 * counted after, so checks sent at the same moment cannot all get past the
 * limit: each sees the others. Over the limit, the row is removed and
 * `exhausted` is thrown with the seconds until the oldest row in the window
 * expires.
 */
export async function reserveDailyAttempt(
  ledger: DailyAttemptLedger,
  wawuUserId: string,
  perDayLimit: number,
  exhausted: (retryAfterSeconds: number) => Error,
): Promise<{ id: string; used: number }> {
  const id = await ledger.create(wawuUserId);
  const since = new Date(Date.now() - BVN_CHECK_WINDOW_MS);
  const used = await ledger.count(wawuUserId, since);
  if (used <= perDayLimit) return { id, used };

  await ledger.remove(id);
  const oldest = await ledger.oldestSince(wawuUserId, since);
  const freesAt = (oldest?.getTime() ?? Date.now()) + BVN_CHECK_WINDOW_MS;
  throw exhausted(Math.max(1, Math.ceil((freesAt - Date.now()) / 1000)));
}

/**
 * Hashes the BVN and the NIN under IDENTITY_HASH_KEY. Unset (production
 * before the key is added, like Fintava's settings before OPS-10): the
 * server still starts, logs one warning, and the BVN check answers 503. A
 * key that is set but shorter than 32 characters stops the app at boot.
 * The key is kept in a private field: not in `inspect`, not in JSON.
 */
@Injectable()
export class IdentityHasher {
  private readonly logger = new Logger(IdentityHasher.name);
  readonly #key: string;
  readonly checksPerDay: number;
  /** Selfie matches per person per 24 hours (KYC-02). */
  readonly selfieChecksPerDay: number;

  constructor(config: ConfigService) {
    const raw = (config.get<string>(IDENTITY_CONFIG_KEYS.hashKey) ?? '').trim();
    if (raw !== '' && raw.length < IDENTITY_HASH_KEY_MIN_LENGTH) {
      throw new IdentityConfigError(
        `${IDENTITY_CONFIG_KEYS.hashKey} must be at least ${IDENTITY_HASH_KEY_MIN_LENGTH} characters.`,
      );
    }
    this.#key = raw;
    this.checksPerDay = bvnChecksPerDay(
      config.get<string>(IDENTITY_CONFIG_KEYS.checksPerDay),
    );
    this.selfieChecksPerDay = selfieChecksPerDay(
      config.get<string>(IDENTITY_CONFIG_KEYS.selfieChecksPerDay),
    );
    if (raw === '') {
      this.logger.warn(
        `${IDENTITY_CONFIG_KEYS.hashKey} is not set: the BVN check and the selfie match answer 503 until it is.`,
      );
    }
  }

  get configured(): boolean {
    return this.#key !== '';
  }

  /**
   * HMAC-SHA256, hex. `kind` keeps a BVN and a NIN with the same digits
   * apart; `name` is one word of the BVN record's name (WALLET-14).
   */
  hash(kind: 'bvn' | 'nin' | 'name', value: string): string {
    if (!this.configured) {
      throw new IdentityConfigError(
        `${IDENTITY_CONFIG_KEYS.hashKey} is not set.`,
      );
    }
    return createHmac('sha256', this.#key)
      .update(`${kind}:${value}`)
      .digest('hex');
  }

  toJSON(): { configured: boolean } {
    return { configured: this.configured };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `IdentityHasher { configured: ${this.configured} }`;
  }
}
