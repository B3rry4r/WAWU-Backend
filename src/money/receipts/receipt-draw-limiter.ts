import { ServiceUnavailableException } from '@nestjs/common';

/** What a person is told when every drawing slot stayed busy for the whole wait. */
export const RECEIPT_BUSY_MESSAGE =
  'Receipts are busy right now. Try again in a few seconds.';

/** Seconds the busy answer asks the app to wait (Retry-After). */
export const RECEIPT_BUSY_RETRY_SECONDS = 5;

/** The refusal when no drawing slot came free in time: 503, with Retry-After. */
export class ReceiptBusyError extends ServiceUnavailableException {
  constructor() {
    super(RECEIPT_BUSY_MESSAGE);
  }
}

/**
 * At most `slots` receipt drawings at once in this process (task WALLET-18,
 * round 3). A PDF in flight holds about 45 MB of pixels, so ten at once took
 * the server from 173 MB to about 640 MB; with this, a burst queues instead.
 * A request waits up to `waitMs` for a slot, first come first served, then
 * is refused with ReceiptBusyError. `peak` is the most ever drawing at once.
 */
export class DrawLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  peak = 0;

  constructor(
    readonly slots: number,
    readonly waitMs: number,
  ) {}

  get inFlight(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(draw: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await draw();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.slots) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        this.take();
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.queue.indexOf(turn);
        if (at >= 0) this.queue.splice(at, 1);
        reject(new ReceiptBusyError());
      }, this.waitMs);
      this.queue.push(turn);
    });
  }

  private take() {
    this.running += 1;
    this.peak = Math.max(this.peak, this.running);
  }

  private release() {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
