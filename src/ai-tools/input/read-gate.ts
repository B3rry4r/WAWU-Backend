import { ServiceUnavailableException } from '@nestjs/common';

/** What a person is told when the Hub is already reading as many recordings as it will. Nothing was held. */
export const READ_BUSY_MESSAGE =
  'Other recordings are being read right now. Try again in a moment. No points were taken.';

export interface ReadGateLimits {
  /** Files read and parsed at once (each holds its bytes and a parser's heap). */
  parallel: number;
  /** Reads allowed to wait for a turn; the next one is refused at once. A waiting read holds no bytes. */
  waiting: number;
  /** The longest a read waits for its turn before it is refused. */
  waitMs: number;
  /** Bytes of files in memory at once across the turns (a lone file may be bigger: the input cap). */
  budgetBytes: number;
}

/** The Hub's limits (AITOOLS-04 round 3). */
export const READ_GATE_LIMITS: ReadGateLimits = {
  parallel: 2,
  waiting: 3,
  waitMs: 20_000,
  budgetBytes: 512 * 1024 * 1024,
};

interface Waiter {
  bytes: number;
  start: () => void;
  timer: NodeJS.Timeout;
}

interface AccountWaiter {
  go: () => void;
  timer: NodeJS.Timeout;
}

/**
 * Who may read a person's file into memory, and when (AITOOLS-04 round 3).
 * The verifier put six hostile 100 MB files through and the Hub went from 268
 * to 1821 MB: every file was read whole BEFORE it waited for the parser. Now:
 *
 *   - one read in flight per account (`claimAccount`; a second waits its
 *     turn, a third answers busy);
 *   - a read takes its turn BEFORE the file is read (`takeTurn`), so a file
 *     that waits is not in memory;
 *   - at most `parallel` files at once, and no more than `budgetBytes` of
 *     them together;
 *   - at most `waiting` reads waiting, each for at most `waitMs`; past either
 *     the read is refused with the Hub's busy answer and nothing is held.
 *
 * Memory is therefore bounded by the budget (or one file at the input cap)
 * plus what the parser may add (`WORKER_EXTRA_MEMORY_BYTES` for each turn).
 */
export class ReadGate {
  private running = 0;
  private bytes = 0;
  private readonly accounts = new Map<string, { next: AccountWaiter[] }>();
  private readonly queue: Waiter[] = [];

  constructor(readonly limits: ReadGateLimits = READ_GATE_LIMITS) {}

  /** Reads running now and reads waiting (for the specs and the logs). */
  stats(): { running: number; waiting: number; bytes: number } {
    return {
      running: this.running,
      waiting: this.queue.length,
      bytes: this.bytes,
    };
  }

  /**
   * The account's one read in flight, from before the file is touched until
   * the returned function is called. A second read from the same account
   * waits for the first (a person tapping twice is served in turn, as before);
   * a third while one already waits, or a wait longer than `waitMs`, is the
   * busy answer. A waiting read holds nothing.
   */
  claimAccount(accountId: string): Promise<() => void> {
    const line = this.accounts.get(accountId);
    if (line === undefined) {
      this.accounts.set(accountId, { next: [] });
      return Promise.resolve(this.accountRelease(accountId));
    }
    if (line.next.length >= 1)
      return Promise.reject(new ServiceUnavailableException(READ_BUSY_MESSAGE));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: AccountWaiter = {
        go: () => resolve(this.accountRelease(accountId)),
        timer: setTimeout(() => {
          const at = line.next.indexOf(waiter);
          if (at >= 0) line.next.splice(at, 1);
          reject(new ServiceUnavailableException(READ_BUSY_MESSAGE));
        }, this.limits.waitMs),
      };
      waiter.timer.unref();
      line.next.push(waiter);
    });
  }

  private accountRelease(accountId: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const line = this.accounts.get(accountId);
      const next = line?.next.shift();
      if (next) {
        clearTimeout(next.timer);
        next.go(); // the account's place passes to its waiting read
      } else this.accounts.delete(accountId);
    };
  }

  /**
   * A turn to read and parse a file of `bytes`. Resolves with the function
   * that gives the turn back; call it when the bytes are gone. Throws the
   * busy answer when too many reads already wait, or this one waited too long.
   */
  takeTurn(bytes: number): Promise<() => void> {
    if (this.queue.length === 0 && this.fits(bytes))
      return Promise.resolve(this.start(bytes));
    if (this.queue.length >= this.limits.waiting)
      return Promise.reject(new ServiceUnavailableException(READ_BUSY_MESSAGE));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        bytes,
        start: () => resolve(this.start(bytes)),
        timer: setTimeout(() => {
          const at = this.queue.indexOf(waiter);
          if (at >= 0) this.queue.splice(at, 1);
          reject(new ServiceUnavailableException(READ_BUSY_MESSAGE));
        }, this.limits.waitMs),
      };
      waiter.timer.unref();
      this.queue.push(waiter);
    });
  }

  private fits(bytes: number): boolean {
    if (this.running === 0) return true; // a lone file is always allowed
    return (
      this.running < this.limits.parallel &&
      this.bytes + bytes <= this.limits.budgetBytes
    );
  }

  private start(bytes: number): () => void {
    this.running += 1;
    this.bytes += bytes;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.running -= 1;
      this.bytes -= bytes;
      this.pump();
    };
  }

  private pump(): void {
    while (this.queue.length > 0 && this.fits(this.queue[0].bytes)) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      next.start();
    }
  }
}

/** The Hub's one gate: every parse of a person's file goes through it. */
export const readGate = new ReadGate();
