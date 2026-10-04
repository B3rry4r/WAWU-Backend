import { Injectable } from '@nestjs/common';
import { MoneyError } from '../money-error';

/**
 * Limits on statements (task WALLET-27, rounds 2 and 3). A statement's cost
 * grows with the rows in its period, and the day cap (STATEMENT_MAX_DAYS)
 * bounds days, not rows: the round-1 load run (100,000 rows in a year, 20
 * statements at once from one address) took 39 s and took the server to
 * 1.6 GB. So a statement is capped in rows, limited per person, and only
 * two are built at once in the process.
 *
 * The app's global throttlers (`short` and `medium`, per address) apply to
 * this route exactly as to every other one: nothing here overrides them.
 * Round 2 overrode their tracker with an unverified token `sub`, which let
 * one address with forged tokens skip the per-address limit and fill the
 * throttler's storage (verifier round 2, defect 1). The per-person limit
 * below runs only after WawuAuthGuard has verified the token, keyed by the
 * verified wawuUserId, in a map it prunes itself.
 */

/**
 * The most movements one statement lists. A period holding more is
 * refused with `400 statement_too_large` after a count, before any row is
 * read or written into a file. Default (agent/lead), owner may override:
 * the lead's ruling of 3 Oct 2026; at about 185 bytes a line that is a file
 * of some 9 MB.
 */
export const STATEMENT_MAX_ROWS = 50_000;

/**
 * PROVISIONAL(STATEMENT-RATE-LIMITS, owner=YOU, why=no ruling names how many statements a person may ask for; the lead set 5 a minute and 30 an hour after the verifier's load run)
 *
 * Statements one person (the verified wawuUserId) may ask for: at most 5
 * in a minute and 30 in an hour, each a fixed window that starts at that
 * person's first request in it. Beyond either is `429
 * statement_rate_limited` with `retryAfterSeconds`. Default (agent/lead),
 * owner may override.
 */
export const STATEMENT_RATE_LIMITS = [
  { name: 'minute', limit: 5, windowMs: 60_000 },
  { name: 'hour', limit: 30, windowMs: 60 * 60_000 },
] as const;

/**
 * PROVISIONAL(STATEMENT-CONCURRENCY, owner=YOU, why=the droplet runs one process and no ruling states its memory; five 49,999-row statements at once peaked at 1.2 GB)
 *
 * Statements built at once in this process: 2. Another waits up to
 * STATEMENT_WAIT_MS for a place, then is `503 statement_busy` with
 * `retryAfterSeconds`. Default (agent/lead), owner may override.
 */
export const STATEMENT_CONCURRENCY = 2;
export const STATEMENT_WAIT_MS = 5_000;

export const STATEMENT_RATE_LIMITED_MESSAGE =
  'You have asked for a lot of statements in a short time. Try again in a little while.';
export const STATEMENT_BUSY_MESSAGE =
  'Statements are busy right now. Try again in a few seconds.';

/** How often the limiter sweeps out people whose windows have all ended. */
const PRUNE_EVERY_MS = 60_000;

/**
 * The per-person statement limit: a fixed-window counter per verified
 * wawuUserId, in memory, one process.
 *
 * Bounded: an entry is made only by `take`, which the controller calls
 * after WawuAuthGuard verified the token and the wallet gate found the
 * person's wallet, so a request with a forged or no token never makes one.
 * An entry whose windows have all ended is removed by a sweep at most once
 * a minute (and checked on its own next use), so the map holds at most the
 * people who asked for a statement in the last hour. No timer is kept per
 * request.
 */
@Injectable()
export class StatementRateLimiter {
  /** The clock; a test may replace it. */
  now: () => number = () => Date.now();
  private readonly entries = new Map<
    string,
    { starts: number[]; counts: number[] }
  >();
  private lastPrune = 0;

  /**
   * Counts one statement for this person, or refuses with 429. Returns a
   * function that gives the place back (for an answer that should not
   * count, `statement_too_large`); it gives back only within the windows it
   * was counted in, and only once.
   */
  take(wawuUserId: string): () => void {
    const now = this.now();
    if (now - this.lastPrune >= PRUNE_EVERY_MS) this.prune(now);
    let e = this.entries.get(wawuUserId);
    if (!e) {
      e = {
        starts: STATEMENT_RATE_LIMITS.map(() => now),
        counts: STATEMENT_RATE_LIMITS.map(() => 0),
      };
      this.entries.set(wawuUserId, e);
    }
    let waitMs = 0;
    STATEMENT_RATE_LIMITS.forEach((w, i) => {
      if (now - e.starts[i] >= w.windowMs) {
        e.starts[i] = now;
        e.counts[i] = 0;
      }
      if (e.counts[i] >= w.limit) {
        waitMs = Math.max(waitMs, e.starts[i] + w.windowMs - now);
      }
    });
    if (waitMs > 0) {
      throw new MoneyError(
        'statement_rate_limited',
        STATEMENT_RATE_LIMITED_MESSAGE,
        { retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) },
      );
    }
    STATEMENT_RATE_LIMITS.forEach((_w, i) => {
      e.counts[i] += 1;
    });
    const starts = [...e.starts];
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const now = this.entries.get(wawuUserId);
      if (!now) return;
      STATEMENT_RATE_LIMITS.forEach((_w, i) => {
        if (now.starts[i] === starts[i] && now.counts[i] > 0)
          now.counts[i] -= 1;
      });
    };
  }

  /** Removes everyone whose every window has ended. */
  prune(now: number = this.now()): void {
    this.lastPrune = now;
    for (const [key, e] of this.entries) {
      const live = STATEMENT_RATE_LIMITS.some(
        (w, i) => now - e.starts[i] < w.windowMs,
      );
      if (!live) this.entries.delete(key);
    }
  }

  /** How many people the limiter holds (for tests and the bound above). */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * At most STATEMENT_CONCURRENCY statements built at once in this process.
 * A request past that waits in order up to STATEMENT_WAIT_MS for a place,
 * then is `503 statement_busy`. Each waiter holds one timer for at most
 * that long, cleared when it gets a place.
 */
@Injectable()
export class StatementSlots {
  /** Places; a test may change these. */
  max = STATEMENT_CONCURRENCY;
  waitMs = STATEMENT_WAIT_MS;
  private active = 0;
  /** The most built at once since start (for tests). */
  peak = 0;
  private readonly waiting: Array<{
    go: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  async run<T>(build: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await build();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        go: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(
            new MoneyError('statement_busy', STATEMENT_BUSY_MESSAGE, {
              retryAfterSeconds: Math.max(1, Math.ceil(this.waitMs / 1000)),
            }),
          );
        }, this.waitMs),
      };
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    // The place passes straight to the next in line; `active` is unchanged.
    if (next) next.go();
    else this.active -= 1;
  }
}
