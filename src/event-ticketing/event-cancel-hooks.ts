import { Injectable, Logger } from '@nestjs/common';

/** What a step run after an event is called off reports back (task EVENTS-10). */
export interface CalledOffRefunds {
  /** Orders whose price is on its way back or back with the buyer (the hold's refund is chosen). */
  refunded: number;
  /** Orders whose price cannot go back by itself (the host's share was already paid out): a person settles them. */
  needAttention: number;
  /**
   * Orders still waiting for their refund when the step returned (the request's time ran out or the provider
   * could not be asked yet): the minute sweep sends them. Left out when none
   * (EVENTS-13), so ordersRefunded + refundsNeedingAttention + this always
   * equals the paid orders.
   */
  leftToSweep?: number;
}

/**
 * A step a feature runs after an event is called off, for money the web's
 * Flutterwave refunds do not cover. The wallet tickets (EVENTS-07) are held
 * prices (R-19) that only the hold's own refund can send back, and the wallet
 * module cannot be imported here: EventTicketingModule is mounted before
 * MoneyModule, and importing MoneyModule from it would register every money
 * route earlier than today. The wallet module registers itself instead, the
 * way the account purge takes its steps.
 *
 * A step never throws into the cancel: what it could not finish is left to its
 * own sweep. It must be safe to run again.
 */
export type AfterCalledOffHook = (eventId: string) => Promise<CalledOffRefunds>;

@Injectable()
export class EventCancelHooks {
  private readonly logger = new Logger(EventCancelHooks.name);
  private readonly after: AfterCalledOffHook[] = [];

  register(hook: AfterCalledOffHook): void {
    this.after.push(hook);
  }

  async afterCalledOff(eventId: string): Promise<CalledOffRefunds> {
    const total: CalledOffRefunds = { refunded: 0, needAttention: 0 };
    for (const hook of this.after) {
      try {
        const counts = await hook(eventId);
        total.refunded += counts.refunded;
        total.needAttention += counts.needAttention;
        if (counts.leftToSweep) {
          total.leftToSweep = (total.leftToSweep ?? 0) + counts.leftToSweep;
        }
      } catch (e) {
        // The step's own sweep finishes it; the host's cancel has happened.
        this.logger.error(
          `event ${eventId}: a step after the cancel failed (${e instanceof Error ? e.name : 'error'}); its sweep looks again`,
        );
      }
    }
    return total;
  }
}
