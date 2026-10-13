/**
 * Keeps the Hub under the provider's request rate: no more than `perSecond`
 * requests start in any one second (EMAIL-01). `acquire()` resolves when the
 * caller may start a request. The clock and the wait are injected so a spec
 * can prove the cap without waiting.
 */
export class RequestPacer {
  private readonly starts: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Callers are served one at a time, in order. */
  acquire(): Promise<void> {
    const turn = this.chain.then(() => this.take());
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  private async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.starts.length > 0 && t - this.starts[0] >= 1000)
        this.starts.shift();
      if (this.starts.length < this.perSecond) {
        this.starts.push(t);
        return;
      }
      await this.sleep(Math.max(1, 1000 - (t - this.starts[0])));
    }
  }
}
