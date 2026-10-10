import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WaitlistStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  RECHECK_AFTER_MS,
  RECHECK_BATCH,
  RECHECK_EVERY,
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

  @Cron(RECHECK_EVERY, { name: 'waitlist-recheck-pending' })
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

  /** Looks up the pending rows in the window; returns how many it looked at and how many it marked paid. */
  async recheckPending(
    now: Date = new Date(),
  ): Promise<{ checked: number; paid: number }> {
    const rows = await this.prisma.waitlistRegistration.findMany({
      where: {
        status: WaitlistStatus.pending,
        createdAt: {
          lte: new Date(now.getTime() - RECHECK_AFTER_MS),
          gt: new Date(now.getTime() - RECHECK_UNTIL_MS),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: RECHECK_BATCH,
    });
    let paid = 0;
    for (const row of rows) {
      try {
        if (await this.waitlist.recheck(row)) paid += 1;
      } catch (e) {
        // One row's trouble (Flutterwave unreachable) never stops the rest.
        this.logger.warn(
          `Re-check of ${row.reference.slice(0, 18)} failed: ${e instanceof Error ? e.name : 'error'}`,
        );
      }
    }
    if (rows.length > 0)
      this.logger.log(
        `Re-checked ${rows.length} pending registration(s); ${paid} paid.`,
      );
    return { checked: rows.length, paid };
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
