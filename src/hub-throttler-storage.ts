import {
  Injectable,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * One caller's count for one throttler on one route: the `key` the guard
 * generated (class, handler, throttler name and tracker, hashed) under the
 * throttler's name.
 */
interface Bucket {
  /** When each counted hit stops counting, oldest first. */
  hits: number[];
  /** The fixed window behind `X-RateLimit-Reset` (`timeToExpire`). */
  windowEndsAt: number;
  blocked: boolean;
  blockEndsAt: number;
  /** After this, the bucket holds nothing a new one would not: it can go. */
  until: number;
}

/**
 * How often idle buckets are swept, and how many are looked at before the
 * sweep yields the event loop. Implementation constants, not rate limits:
 * the limits stay in src/hub-throttlers.ts and on each `@Throttle`.
 */
export const HUB_THROTTLER_SWEEP_MS = 10_000;
export const HUB_THROTTLER_SWEEP_CHUNK = 5_000;

/**
 * FIX-05: the rate-limit store, in place of @nestjs/throttler 6.5's in-memory
 * ThrottlerStorageService.
 *
 * That store expires each hit with its own `setTimeout`, and keeps the timer
 * ids in ONE list per throttler name. When any caller's block ends it clears
 * that whole list (`resetBlockdRequest` -> `clearExpirationTimes(name)`), so
 * every other caller's hits stop expiring, their counts only climb, and
 * people who never went near the limit get 429 (G-95, found on WALLET-27).
 *
 * Here every count lives in its own bucket, keyed by throttler name and the
 * guard's key, and nothing one bucket does reaches another. There are no
 * per-hit timers: a hit is a timestamp, expired ones are dropped when the
 * bucket is next touched, and idle buckets are removed by one periodic sweep
 * (unref'd, in chunks, so a large store never stalls the event loop).
 *
 * The answers are the library's, hit for hit, so every limit, `@Throttle`
 * override and header behaves as before: each hit counts for `ttl` after it
 * arrives (a sliding window); the hit that takes the count over `limit`
 * blocks the bucket for `blockDuration`, and blocked requests are not
 * counted; the first request after the block starts a fresh count of 1;
 * `timeToExpire` is the library's fixed window, renewed once it has passed.
 * Times are returned in whole seconds, rounded up, as the library does.
 */
@Injectable()
export class HubThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly buckets = new Map<string, Bucket>();
  private sweeper?: ReturnType<typeof setInterval>;
  private sweeping = false;

  /** How many buckets are held now, idle ones included until swept. */
  get size(): number {
    return this.buckets.size;
  }

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    this.startSweeper();
    const now = Date.now();
    const id = `${throttlerName}:${key}`;
    let bucket = this.buckets.get(id);
    if (bucket && bucket.until <= now) {
      // Idle: an empty bucket answers exactly as this one would.
      this.buckets.delete(id);
      bucket = undefined;
    }
    if (!bucket) {
      bucket = {
        hits: [],
        windowEndsAt: now + ttl,
        blocked: false,
        blockEndsAt: 0,
        until: 0,
      };
      this.buckets.set(id, bucket);
    }

    const hits = bucket.hits;
    while (hits.length > 0 && hits[0] <= now) hits.shift();
    if (bucket.windowEndsAt <= now) bucket.windowEndsAt = now + ttl;

    // The library's order: count unless blocked; block on going over; a
    // block that has ended starts a fresh count with this request.
    if (!bucket.blocked) this.count(hits, now + ttl);
    if (!bucket.blocked && hits.length > limit) {
      bucket.blocked = true;
      bucket.blockEndsAt = now + blockDuration;
    }
    if (bucket.blocked && bucket.blockEndsAt <= now) {
      bucket.blocked = false;
      hits.length = 0;
      this.count(hits, now + ttl);
    }

    bucket.until = Math.max(
      hits.length > 0 ? hits[hits.length - 1] : 0,
      bucket.windowEndsAt,
      bucket.blocked ? bucket.blockEndsAt : 0,
    );

    return Promise.resolve({
      totalHits: hits.length,
      timeToExpire: Math.ceil((bucket.windowEndsAt - now) / 1000),
      isBlocked: bucket.blocked,
      timeToBlockExpire: bucket.blocked
        ? Math.ceil((bucket.blockEndsAt - now) / 1000)
        : 0,
    });
  }

  /**
   * Removes every idle bucket. Looks at `HUB_THROTTLER_SWEEP_CHUNK` buckets
   * at a time and yields between chunks. Resolves to how many were removed.
   */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let removed = 0;
    try {
      let seen = 0;
      for (const [id, bucket] of this.buckets) {
        if (bucket.until <= Date.now()) {
          this.buckets.delete(id);
          removed++;
        }
        if (++seen % HUB_THROTTLER_SWEEP_CHUNK === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      this.sweeping = false;
    }
    return removed;
  }

  onApplicationShutdown(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Inserts an expiry, keeping the list oldest first. */
  private count(hits: number[], expiresAt: number): void {
    let i = hits.length;
    while (i > 0 && hits[i - 1] > expiresAt) i--;
    hits.splice(i, 0, expiresAt);
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.sweep();
    }, HUB_THROTTLER_SWEEP_MS);
    // Never what keeps the process (or a test run) alive.
    this.sweeper.unref();
  }
}

/**
 * Registered in AppModule's own providers, so the global ThrottlerGuard
 * there is given this store instead of the library's default one.
 */
export const HUB_THROTTLER_STORAGE: Provider = {
  provide: ThrottlerStorage,
  useClass: HubThrottlerStorage,
};
