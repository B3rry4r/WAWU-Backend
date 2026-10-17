import { Injectable } from '@nestjs/common';

/**
 * A step a feature runs before an account's rows are deleted, for a thing that
 * cannot be settled by deleting a row (EVENTS-07 round 2: a buyer's money held
 * for a host's event is sent back before the event goes).
 *
 * A hook that throws stops the purge before it deletes anything, so the sweep
 * that called it tries again; it must be safe to run again.
 */
export type BeforeEraseHook = (wawuUserId: string) => Promise<void>;

@Injectable()
export class AccountPurgeHooks {
  private readonly before: BeforeEraseHook[] = [];

  register(hook: BeforeEraseHook): void {
    this.before.push(hook);
  }

  async beforeErase(wawuUserId: string): Promise<void> {
    for (const hook of this.before) await hook(wawuUserId);
  }
}
