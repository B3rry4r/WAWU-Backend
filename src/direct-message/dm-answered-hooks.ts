import { Injectable, Logger } from '@nestjs/common';

/**
 * A step run after a creator has answered a paid question (task INBOX-17).
 * The answer is already written when it runs. A paid question paid from the
 * wallet is a held price (R-19) that only the hold's own release can pay out,
 * and the direct-message module cannot import the wallet module: the wallet
 * module registers itself here instead, the way the cancel hooks and the
 * account purge take their steps.
 *
 * A step never throws into the reply: the creator has answered, and what the
 * step could not finish is left to its own sweep. It must be safe to run again.
 */
export type AfterAnsweredHook = (message: {
  id: string;
  flutterwaveTxRef: string;
}) => Promise<void>;

@Injectable()
export class DmAnsweredHooks {
  private readonly logger = new Logger(DmAnsweredHooks.name);
  private readonly after: AfterAnsweredHook[] = [];

  register(hook: AfterAnsweredHook): void {
    this.after.push(hook);
  }

  async afterAnswered(message: {
    id: string;
    flutterwaveTxRef: string;
  }): Promise<void> {
    for (const hook of this.after) {
      try {
        await hook(message);
      } catch (e) {
        this.logger.error(
          `question ${message.id}: a step after the answer failed (${e instanceof Error ? e.name : 'error'}); its sweep looks again`,
        );
      }
    }
  }
}
