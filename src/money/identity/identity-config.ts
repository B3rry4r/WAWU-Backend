import { createHmac, hkdfSync } from 'node:crypto';
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
  // NUV-02 round 3: a Nuvion opening left unfinished lets go of its BVN
  // after this many days, and tries are limited per address.
  holdDays: 'IDENTITY_HOLD_DAYS',
  // NUV-03 round 4 (R4-2): one account holds one BVN for at most this many
  // days from the first claim, whatever progress is recorded.
  holdLifetimeDays: 'IDENTITY_HOLD_LIFETIME_DAYS',
  opensPerAddressPerHour: 'OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR',
} as const;

/** A key derived from IDENTITY_HASH_KEY (`deriveKey`): 32 bytes, AES-256. */
const DERIVED_KEY_BYTES = 32;

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
 *
 * Under a provider that reviews the person itself (Nuvion) there is no BVN
 * check; the same number and the same ledger are the day's opening tries
 * that name a BVN or NIN (NUV-02, `src/money/opening/opening-attempts.ts`).
 */
export const DEFAULT_BVN_CHECKS_PER_DAY = 3;

/** The window the daily limit counts over: a rolling 24 hours. */
export const BVN_CHECK_WINDOW_MS = 24 * 60 * 60_000;

/**
 * PROVISIONAL(IDENTITY-HOLD-DAYS, owner=YOU, why=the lead set 14 days on 9 Oct 2026 as a default; the owner has not named how long an unfinished opening may hold a BVN)
 *
 * Under a provider that reviews the person (Nuvion): an opening that sits at
 * "documents needed", or was refused only for its documents, with nothing
 * from the person for this many days is marked expired. Its BVN is let go,
 * the person is told once and starts again; nothing is deleted at Nuvion
 * (NUV-02 round 3, N3). Overridable with IDENTITY_HOLD_DAYS.
 */
export const DEFAULT_IDENTITY_HOLD_DAYS = 14;

/**
 * PROVISIONAL(IDENTITY-HOLD-LIFETIME-DAYS, owner=YOU, why=the lead set 30 days on 10 Oct 2026 as a default after the NUV-02 round 4 verifier showed that a 4 byte upload every 13 days kept a stranger's BVN held for ever; the owner has not named how long one account may hold a BVN while its opening is unfinished)
 *
 * Under a provider that reviews the person (Nuvion): the longest one account
 * may hold one BVN while its opening is still at "documents needed" (or
 * refused only about its documents or details), counted from the day the
 * account took the claim on that number, whatever the person has done since
 * (NUV-03 round 4, R4-2). When it ends the opening is marked expired by the
 * sweep, exactly as an idle one is: the BVN is let go, the person is told
 * once and starts again (which takes a new claim, and so a new lifetime).
 * Overridable with IDENTITY_HOLD_LIFETIME_DAYS; never shorter than
 * IDENTITY_HOLD_DAYS.
 */
export const DEFAULT_IDENTITY_HOLD_LIFETIME_DAYS = 30;

/**
 * PROVISIONAL(OPEN-ATTEMPTS-PER-ADDRESS, owner=YOU, why=the lead set 10 an hour on 9 Oct 2026 as a default; no ruling names a per-address limit for opening a wallet)
 *
 * Opening tries (the ones that name a BVN or NIN and count against the
 * day's tries) one address may make in an hour, across every account, so a
 * squatter cannot sweep BVNs from one place (NUV-02 round 3). A plain 429
 * with its own reason code. Overridable with
 * OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR.
 */
export const DEFAULT_OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR = 10;

/** The window the per-address limit counts over: a rolling hour. */
export const OPEN_ADDRESS_WINDOW_MS = 60 * 60_000;

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

/**
 * The client address an opening try is counted under (NUV-02 round 3), or
 * null when there is none to count: a call made on the server itself with no
 * proxy header (a loopback peer that names no client). Behind nginx the
 * address is the real caller's (`bvnCheckTracker`).
 */
export function openingAddressOf(
  request: Record<string, unknown>,
): string | null {
  const address = bvnCheckTracker(request);
  return address === '' || LOOPBACK.has(address) ? null : address;
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

/** Reads IDENTITY_HOLD_DAYS (1 to 365); unset means the provisional default. */
export function identityHoldDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDENTITY_HOLD_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new IdentityConfigError(
      `${IDENTITY_CONFIG_KEYS.holdDays} must be a whole number from 1 to 365.`,
    );
  }
  return n;
}

/** Reads IDENTITY_HOLD_LIFETIME_DAYS (1 to 365); unset means the provisional default. */
export function identityHoldLifetimeDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_IDENTITY_HOLD_LIFETIME_DAYS;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new IdentityConfigError(
      `${IDENTITY_CONFIG_KEYS.holdLifetimeDays} must be a whole number from 1 to 365.`,
    );
  }
  return n;
}

/** Reads OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR (1 to 100000); unset means the default. */
export function openAttemptsPerAddressPerHour(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    throw new IdentityConfigError(
      `${IDENTITY_CONFIG_KEYS.opensPerAddressPerHour} must be a whole number from 1 to 100000.`,
    );
  }
  return n;
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
  throw exhausted(secondsUntilFree(oldest));
}

/**
 * Seconds until the daily window frees a place, from the oldest row still
 * inside it (at least 1). The one formula, so the 429 a reservation throws
 * and the time a view shows (NUV-02 round 3, N6) are the same number.
 */
export function secondsUntilFree(
  oldest: Date | null,
  windowMs: number = BVN_CHECK_WINDOW_MS,
): number {
  const freesAt = (oldest?.getTime() ?? Date.now()) + windowMs;
  return Math.max(1, Math.ceil((freesAt - Date.now()) / 1000));
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
  /** Days an unfinished Nuvion opening holds its BVN (NUV-02 round 3). */
  readonly holdDays: number;
  /**
   * The most days one account holds one BVN while its opening is unfinished,
   * from the first claim, whatever the person does meanwhile (NUV-03 round 4).
   */
  readonly holdLifetimeDays: number;
  /** Opening tries one address may make an hour (NUV-02 round 3). */
  readonly opensPerAddressPerHour: number;

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
    this.holdDays = identityHoldDays(
      config.get<string>(IDENTITY_CONFIG_KEYS.holdDays),
    );
    this.holdLifetimeDays = identityHoldLifetimeDays(
      config.get<string>(IDENTITY_CONFIG_KEYS.holdLifetimeDays),
    );
    if (this.holdLifetimeDays < this.holdDays) {
      throw new IdentityConfigError(
        `${IDENTITY_CONFIG_KEYS.holdLifetimeDays} (${this.holdLifetimeDays}) must not be shorter than ${IDENTITY_CONFIG_KEYS.holdDays} (${this.holdDays}).`,
      );
    }
    this.opensPerAddressPerHour = openAttemptsPerAddressPerHour(
      config.get<string>(IDENTITY_CONFIG_KEYS.opensPerAddressPerHour),
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

  /**
   * HMAC-SHA256, hex, over the bytes of an uploaded file (NUV-03), under the
   * same key as `hash`. The bytes are never turned into a string, and the
   * label keeps this use of the key apart from the others. What it gives is
   * a fingerprint of a person's upload, so the same file sent twice is
   * forwarded once; with the key unset it throws, as `hash` does.
   */
  hashBytes(kind: 'document', parts: ReadonlyArray<Buffer | string>): string {
    if (!this.configured) {
      throw new IdentityConfigError(
        `${IDENTITY_CONFIG_KEYS.hashKey} is not set.`,
      );
    }
    const h = createHmac('sha256', this.#key);
    h.update(`${kind}:`);
    for (const part of parts) h.update(part);
    return h.digest('hex');
  }

  /**
   * A 32-byte key for one other purpose, derived from IDENTITY_HASH_KEY with
   * HKDF-SHA256 under `label` (RFC 5869: a distinct `info` gives an
   * independent key, so the derived key reveals nothing about the hashing
   * key and no hash can be forged with it). Used by the check handle
   * (`check-handle.ts`), so no new secret has to reach the server: wherever
   * the BVN check can run, this key exists. Throws when the key is not set.
   */
  deriveKey(label: string): Buffer {
    if (!this.configured) {
      throw new IdentityConfigError(
        `${IDENTITY_CONFIG_KEYS.hashKey} is not set.`,
      );
    }
    return Buffer.from(
      hkdfSync('sha256', this.#key, Buffer.alloc(0), label, DERIVED_KEY_BYTES),
    );
  }

  toJSON(): { configured: boolean } {
    return { configured: this.configured };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `IdentityHasher { configured: ${this.configured} }`;
  }
}
