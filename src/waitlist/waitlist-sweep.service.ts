import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { WaitlistRegistration } from '../../generated/prisma/client';
import { WaitlistStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  RECHECK_AFTER_MS,
  RECHECK_EVERY,
  RECHECK_PAGE,
  RECHECK_UNTIL_MS,
  UNPAID_KEEP_MS,
  UNPAID_PURGE_EVERY,
} from './waitlist-config';
import { WaitlistService } from './waitlist.service';

/**
 * Time-based work for the event registration link (JOIN-01).
 *
 * 1. Payers who never came back. A person who pays by bank transfer or USSD,
 *    or whose phone closes after paying, never posts their transaction id.
 *    Every few minutes the `pending` rows old enough to have been paid and
 *    young enough to still matter are looked up at Flutterwave by their
 *    reference and settled by the SAME checks the browser's verify applies
 *    (succeeded, this reference, naira, not less than the fee). Flutterwave's
 *    webhook settles most of them at once (PaymentWebhookService); this is
 *    the net under it, and the one that still works after a failed first
 *    attempt on the same reference has used up the webhook's single claim.
 * 2. Unpaid rows are deleted after a week: no personal data is kept for
 *    people who did not pay. Only `pending` rows go. A `failed` row is a
 *    second payment kept for a refund, and a `paid` row is a registration.
 *
 * Both are idempotent and safe to run twice.
 */
@Injectable()
export class WaitlistSweepService {
  private readonly logger = new Logger(WaitlistSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly waitlist: WaitlistService,
  ) {}

  // waitForCompletion: a tick that finds the last run still going is skipped,
  // so the re-check never overlaps itself on one server. Two servers may still
  // overlap; that is safe because the paid write is conditional (settle).
  @Cron(RECHECK_EVERY, {
    name: 'waitlist-recheck-pending',
    waitForCompletion: true,
  })
  async scheduledRecheck(): Promise<void> {
    await this.recheckPending().catch((e: unknown) =>
      this.logger.error(
        `Re-check of pending registrations failed: ${e instanceof Error ? e.name : 'error'}`,
      ),
    );
  }

  @Cron(UNPAID_PURGE_EVERY, { name: 'waitlist-purge-unpaid' })
  async scheduledPurge(): Promise<void> {
    await this.purgeUnpaid().catch((e: unknown) =>
      this.logger.error(
        `Purge of unpaid registrations failed: ${e instanceof Error ? e.name : 'error'}`,
      ),
    );
  }

  /**
   * Looks up EVERY pending row in the window, a page at a time, and marks the
   * ones Flutterwave says were paid; returns how many it looked at and how
   * many it marked paid.
   *
   * The pages are walked with a keyset cursor on (createdAt, id), the same
   * order the query sorts by, so each row is read once and none is passed
   * over: even when rows leave the window because this run just marked them
   * paid, when many rows share one created time, or when the run is long. A
   * run that stopped after one page would leave the same oldest rows first
   * every time and a newer payer unreached.
   */
  async recheckPending(
    now: Date = new Date(),
  ): Promise<{ checked: number; paid: number }> {
    const due = {
      status: WaitlistStatus.pending,
      createdAt: {
        lte: new Date(now.getTime() - RECHECK_AFTER_MS),
        gt: new Date(now.getTime() - RECHECK_UNTIL_MS),
      },
    };
    let cursor: { createdAt: Date; id: string } | null = null;
    let checked = 0;
    let paid = 0;
    for (;;) {
      const rows: WaitlistRegistration[] =
        await this.prisma.waitlistRegistration.findMany({
          where:
            cursor === null
              ? due
              : {
                  AND: [
                    due,
                    {
                      OR: [
                        { createdAt: { gt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                      ],
                    },
                  ],
                },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: RECHECK_PAGE,
        });
      for (const row of rows) {
        checked += 1;
        try {
          if (await this.waitlist.recheck(row)) paid += 1;
        } catch (e) {
          // One row's trouble (Flutterwave unreachable) never stops the rest.
          this.logger.warn(
            `Re-check of ${row.reference.slice(0, 18)} failed: ${e instanceof Error ? e.name : 'error'}`,
          );
        }
      }
      if (rows.length < RECHECK_PAGE) break;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    if (checked > 0)
      this.logger.log(
        `Re-checked ${checked} pending registration(s); ${paid} paid.`,
      );
    return { checked, paid };
  }

  /** Deletes `pending` rows older than a week; returns how many. */
  async purgeUnpaid(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.waitlistRegistration.deleteMany({
      where: {
        status: WaitlistStatus.pending,
        createdAt: { lt: new Date(now.getTime() - UNPAID_KEEP_MS) },
      },
    });
    if (count > 0)
      this.logger.log(
        `Deleted ${count} unpaid registration(s) older than a week.`,
      );
    return count;
  }
}
