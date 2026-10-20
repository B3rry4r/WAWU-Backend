import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HoldRequestError } from '../../money/holds/hold-rules';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';

/** Holds read at a time, and released at once. Each release holds nothing while it waits for the provider. */
const PAGE = 50;
const CONCURRENCY = 5;
/** One pass stops reading new pages after this long; the next minute carries on. */
const BUDGET_MS = 45_000;

export const EVENT_TOOK_PLACE_REASON = 'the event took place';

/** Hours after an event's end before its ticket money is paid to the host; 0 (the end itself) unless set. */
export function eventPayoutDelayHours(): number {
  const raw = process.env.EVENT_PAYOUT_DELAY_HOURS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 24 * 30 ? n : 0;
}

export interface EventHostPayoutCounts {
  /** Holds whose release was chosen (and driven) in this pass. */
  released: number;
  /** Holds already decided the other way (a refund won), left alone. */
  refundedFirst: number;
}

/**
 * Pays an event host the ticket money once the event has taken place (task
 * WALLET-17, R-19, R-5).
 *
 * - **Through the hold (MONEY-18).** A wallet order's price waits in WAWU's own
 *   account as a `held` `event_ticket` hold, with the host as its payee
 *   (EVENTS-07). Once `endsAt ?? startsAt` (plus `EVENT_PAYOUT_DELAY_HOURS`,
 *   default none) has gone by, the hold is RELEASED: the host's 85% (R-5)
 *   becomes an earning of the host (an `EarningSettlement`, R-55) that rides
 *   their one move a day to their wallet with their other earnings, and WAWU
 *   keeps 15%. A host with no wallet keeps the share, and it lands the minute
 *   they open one (R-11), by the earnings sweep. No money path of its own here.
 * - **Once.** The hold decides one way, once, and sends under its own
 *   reference: a second pass, a second server or this job running twice ask the
 *   same hold and only one move goes out. A hold the other way already
 *   (EVENTS-10 refunded it) is left alone.
 * - **Only an event that took place.** Called off, removed or not yet over, and
 *   an order that is not `paid` (failed, refunded), pays nothing.
 * - **Holding nothing across the provider.** Candidates are read by one query;
 *   every call to the provider is made by the hold service with no
 *   transaction, connection or lock of ours open.
 */
@Injectable()
export class EventHostPayoutService {
  private readonly logger = new Logger(EventHostPayoutService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly holds: WalletHoldService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  /** Every minute. Safe to run on every server and to run twice. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'event-host-payout' })
  async sweep(now = new Date()): Promise<EventHostPayoutCounts> {
    const counts: EventHostPayoutCounts = { released: 0, refundedFirst: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    const started = Date.now();
    const delayHours = eventPayoutDelayHours();
    try {
      let after = '';
      while (Date.now() - started < BUDGET_MS) {
        const due = await this.prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            SELECT h."id" FROM "WalletHold" h
              JOIN "EventOrder" o ON o."walletPaymentId" = h."paymentId"
              JOIN "Event" e ON e."id" = o."eventId"
             WHERE h."kind" = 'event_ticket'
               AND h."status" = 'held' AND h."action" IS NULL
               AND h."provider" = ${this.provider.name}
               AND h."payeeWawuUserId" IS NOT NULL
               AND h."id" > ${after}
               AND o."status" = 'paid'
               AND e."status" = 'published' AND e."cancelledAt" IS NULL
               AND COALESCE(e."endsAt", e."startsAt")
                   + make_interval(hours => ${delayHours}) < ${now}
             ORDER BY h."id" ASC
             LIMIT ${PAGE}`,
        );
        if (due.length === 0) break;
        for (let i = 0; i < due.length; i += CONCURRENCY) {
          const results = await Promise.all(
            due.slice(i, i + CONCURRENCY).map((d) => this.release(d.id)),
          );
          for (const r of results) {
            if (r === 'released') counts.released += 1;
            else if (r === 'refunded_first') counts.refundedFirst += 1;
          }
        }
        after = due[due.length - 1].id;
        if (due.length < PAGE) break;
      }
    } catch (e) {
      this.logger.error(
        `event host payout failed (${e instanceof Error ? e.name : 'error'})`,
      );
    } finally {
      this.sweeping = false;
    }
    if (counts.released > 0) {
      this.logger.log(`${counts.released} ticket hold(s) released to hosts`);
    }
    return counts;
  }

  private async release(
    holdId: string,
  ): Promise<'released' | 'refunded_first' | 'later'> {
    try {
      await this.holds.release({ holdId }, EVENT_TOOK_PLACE_REASON, {
        asEarning: true,
      });
      return 'released';
    } catch (e) {
      if (e instanceof HoldRequestError) {
        // A refund was chosen first (the event was called off, or the host left): theirs stands.
        return e.code === 'other_action_chosen' ? 'refunded_first' : 'later';
      }
      this.logger.error(
        `hold ${holdId}: its release could not be asked (${e instanceof Error ? e.name : 'error'}); the next pass asks again`,
      );
      return 'later';
    }
  }
}
