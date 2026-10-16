/** One fixed window of a per-person limit. */
export interface PersonRateWindow {
  name: string;
  limit: number;
  windowMs: number;
}

/** How often a limiter sweeps out people whose windows have all ended. */
const PRUNE_EVERY_MS = 60_000;

/**
 * A per-person limit: a fixed-window counter per verified wawuUserId, in
 * memory, one process (first written for statements, WALLET-27; shared with
 * the recipient search, WALLET-08).
 *
 * Each window starts at the person's first request in it and holds `limit`
 * requests; a request past any window is refused with the error `refuse`
 * makes, told how many whole seconds (rounded up, at least 1) until the
 * longest-running full window ends.
 *
 * Bounded: an entry is made only by `take`, which a controller calls after
 * WawuAuthGuard verified the token and the wallet gate found the person's
 * wallet, so a request with a forged or no token never makes one. An entry
 * whose windows have all ended is removed by a sweep at most once a minute
 * (and checked on its own next use), so the map holds at most the people who
 * were counted within the longest window. No timer is kept per request.
 */
export class PersonWindowLimiter {
  /** The clock; a test may replace it. */
  now: () => number = () => Date.now();
  private readonly entries = new Map<
    string,
    { starts: number[]; counts: number[] }
  >();
  private lastPrune = 0;

  constructor(
    private readonly windows: readonly PersonRateWindow[],
    private readonly refuse: (retryAfterSeconds: number) => Error,
  ) {}

  /**
   * Counts one request for this person, or throws the refusal. Returns a
   * function that gives the place back (for an answer that should not
   * count); it gives back only within the windows it was counted in, and
   * only once.
   */
  take(wawuUserId: string): () => void {
    const now = this.now();
    if (now - this.lastPrune >= PRUNE_EVERY_MS) this.prune(now);
    let e = this.entries.get(wawuUserId);
    if (!e) {
      e = {
        starts: this.windows.map(() => now),
        counts: this.windows.map(() => 0),
      };
      this.entries.set(wawuUserId, e);
    }
    let waitMs = 0;
    this.windows.forEach((w, i) => {
      if (now - e.starts[i] >= w.windowMs) {
        e.starts[i] = now;
        e.counts[i] = 0;
      }
      if (e.counts[i] >= w.limit) {
        waitMs = Math.max(waitMs, e.starts[i] + w.windowMs - now);
      }
    });
    if (waitMs > 0) {
      throw this.refuse(Math.max(1, Math.ceil(waitMs / 1000)));
    }
    this.windows.forEach((_w, i) => {
      e.counts[i] += 1;
    });
    const starts = [...e.starts];
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const current = this.entries.get(wawuUserId);
      if (!current) return;
      this.windows.forEach((_w, i) => {
        if (current.starts[i] === starts[i] && current.counts[i] > 0)
          current.counts[i] -= 1;
      });
    };
  }

  /** Removes everyone whose every window has ended. */
  prune(now: number = this.now()): void {
    this.lastPrune = now;
    for (const [key, e] of this.entries) {
      const live = this.windows.some((w, i) => now - e.starts[i] < w.windowMs);
      if (!live) this.entries.delete(key);
    }
  }

  /** How many people the limiter holds (for tests and the bound above). */
  get size(): number {
    return this.entries.size;
  }
}
