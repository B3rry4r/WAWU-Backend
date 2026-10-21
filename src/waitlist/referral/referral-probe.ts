import { Injectable } from '@nestjs/common';
import {
  REFERRAL_MISS_LIMIT,
  REFERRAL_MISS_WINDOW_MS,
  REFERRAL_PROBING_WORDS,
} from '../waitlist-config';
import { WaitlistError } from '../waitlist-error';

/**
 * Past this many addresses held in memory, the ones with no recent miss are
 * dropped. An implementation bound on the map, not a rate limit: the limits are
 * REFERRAL_MISS_LIMIT and REFERRAL_MISS_WINDOW_MS in waitlist-config.ts.
 */
const TRACKED_ADDRESSES_MAX = 20_000;

/**
 * SWEEP-JOIN D4: the slowing for someone trying referral codes one after
 * another. It counts, per caller address, the codes that were not ours, over a
 * sliding window kept in this process (the app's own rate limits are kept the
 * same way, in src/hub-throttler-storage.ts). An address at its limit is
 * refused until its oldest miss is older than the window.
 *
 * It never holds a lock, a connection or a transaction, and it reads no
 * database. A code that is ours is never counted, so a person who types the
 * right code is never slowed by it.
 */
@Injectable()
export class ReferralProbeGuard {
  private readonly misses = new Map<string, number[]>();

  /** Misses of `address` still inside the window at `now`, oldest first (pruned). */
  private recent(address: string, now: Date): number[] {
    const since = now.getTime() - REFERRAL_MISS_WINDOW_MS;
    const kept = (this.misses.get(address) ?? []).filter((t) => t > since);
    if (kept.length === 0) this.misses.delete(address);
    else this.misses.set(address, kept);
    return kept;
  }

  /** Refuses with a plain sentence when `address` has used up its tries. */
  assertOpen(address: string | undefined, now: Date): void {
    if (address === undefined) return;
    if (this.recent(address, now).length >= REFERRAL_MISS_LIMIT)
      throw new WaitlistError(
        'referral_attempts_limited',
        REFERRAL_PROBING_WORDS,
      );
  }

  /** Counts one code that was not ours against `address`. */
  recordMiss(address: string | undefined, now: Date): void {
    if (address === undefined) return;
    const kept = this.recent(address, now);
    kept.push(now.getTime());
    this.misses.set(address, kept);
    if (this.misses.size > TRACKED_ADDRESSES_MAX) this.dropIdle(now);
  }

  private dropIdle(now: Date): void {
    for (const address of [...this.misses.keys()]) this.recent(address, now);
  }
}
