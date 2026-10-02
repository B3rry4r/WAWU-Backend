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
 * PROVISIONAL(BVN-CHECK-BURST, owner=YOU, why=no ruling names a per-address limit for a charged identity lookup)
 *
 * The per-address limits the app's global ThrottlerGuard applies to
 * POST /money/identity/bvn, on the app's own named throttlers (`short` and
 * `medium`, app.module.ts): at most 3 a minute and 20 an hour from one
 * address. The per-person limit above is the one that bounds the cost; this
 * one stops one address from running checks for many fresh accounts at
 * once. Carrier NAT puts many people behind one address, hence 20, not 3.
 */
export const BVN_CHECK_THROTTLE = {
  short: { limit: 3, ttl: 60_000 },
  medium: { limit: 20, ttl: 60 * 60_000 },
} as const;

/** A set but unusable identity setting. Stops the app at boot. */
export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigError';
  }
}

/** Reads BVN_CHECKS_PER_DAY; unset means the provisional default. */
export function bvnChecksPerDay(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_BVN_CHECKS_PER_DAY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new IdentityConfigError(
      `${IDENTITY_CONFIG_KEYS.checksPerDay} must be a whole number from 1 to 50.`,
    );
  }
  return n;
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
    if (raw === '') {
      this.logger.warn(
        `${IDENTITY_CONFIG_KEYS.hashKey} is not set: the BVN check answers 503 until it is.`,
      );
    }
  }

  get configured(): boolean {
    return this.#key !== '';
  }

  /** HMAC-SHA256, hex. `kind` keeps a BVN and a NIN with the same digits apart. */
  hash(kind: 'bvn' | 'nin', value: string): string {
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
