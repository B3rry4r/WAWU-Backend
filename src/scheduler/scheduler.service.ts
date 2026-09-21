import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { DmRefundService } from '../direct-message/dm-refund.service';
import type { NotificationEvent } from '../notification/notification-event';

/**
 * Time-based work for the whole API.
 *
 * Nothing in this API ran on a schedule at all — no cron, no queue, no
 * webhook — so a paid DM the creator never answered was never refunded,
 * despite the reply-window guarantee shown to the sender at checkout. The
 * money sat as `held` earnings forever and the creator effectively kept it.
 *
 * A second sweep used to flip lapsed subscriptions to `past_due` and clear
 * the upload gate with them. Subscriptions are gone and uploading is not
 * bought, so it was deleted rather than left to run against nothing.
 *
 * Every sweep here is idempotent and safe to run repeatedly: each one selects
 * only rows still in the state it acts on, and writes conditionally.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly dmRefunds: DmRefundService,
  ) {}

  /**
   * Expire paid DMs whose reply window has passed unanswered, and get the
   * payer's money back.
   *
   * This used to end at the status flip. It marked the DM `refunded`, logged
   * the ids "awaiting Flutterwave refund calls", and told the payer their
   * money was on its way — while no refund call existed anywhere in the
   * codebase. The entitlement was reversed and the money never moved.
   *
   * Now the flip only records the DEBT (`refundStatus: owed`), and
   * DmRefundService is what discharges it. The payer is told once the money
   * is actually back, not when we decided it should be.
   *
   * `deadlineAt` is set once at creation from the window the payer was
   * quoted, and never recomputed, so this stays a pure "past deadline and
   * still awaiting" sweep.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'refund-expired-dms' })
  async refundExpiredDms(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.directMessage.findMany({
      where: { status: 'awaiting_response', deadlineAt: { lt: now } },
      select: { id: true },
      take: 500,
    });

    if (expired.length > 0) {
      const result = await this.prisma.directMessage.updateMany({
        where: {
          id: { in: expired.map((d) => d.id) },
          // Re-checked in the write so a creator replying in the same instant
          // wins the race rather than being refunded out from under them.
          status: 'awaiting_response',
          deadlineAt: { lt: now },
        },
        data: { status: 'refunded', refundStatus: 'owed' },
      });
      if (result.count > 0) {
        this.logger.log(`${result.count} paid DM(s) expired unanswered`);
      }
    }

    // Always run, even when nothing expired this pass: rows left `owed` by an
    // earlier failure, and the backlog the migration enrolled, are owed money
    // too and nothing else would ever pick them up.
    await this.dmRefunds.processOwedRefunds();
  }

  /**
   * Remind a creator that a paid DM's 24-hour window is closing.
   *
   * Runs hourly over a ONE-HOUR band — DMs whose deadline falls between 3
   * and 4 hours from now — which is what makes it fire once per DM without a
   * "reminded" column. A column on DirectMessage was the obvious
   * alternative and was rejected: DirectMessage's wire type is a bare Prisma
   * re-export returned by spread, so a new column would silently widen the
   * live /dm responses the app already consumes.
   *
   * The trade-off, stated: a run that is skipped entirely (deploy, outage)
   * loses that hour's reminders, and two overlapping runs inside the same
   * hour would duplicate them. Neither costs money or entitlement, which is
   * why the cheap version wins here and does not in the refund sweep above.
   *
   * Suppressed by the `dmReminders` notification setting — this is the one
   * kind that flag names exactly.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'remind-dm-deadlines' })
  async remindDmDeadlines(): Promise<void> {
    const now = Date.now();
    const from = new Date(now + 3 * 60 * 60 * 1000);
    const to = new Date(now + 4 * 60 * 60 * 1000);

    const due = await this.prisma.directMessage.findMany({
      where: {
        status: 'awaiting_response',
        deadlineAt: { gte: from, lt: to },
      },
      select: { creatorWawuId: true, deadlineAt: true },
      take: 500,
    });
    if (due.length === 0) return;

    const written = await this.notifications.emitMany(
      due.map(
        (dm): NotificationEvent => ({
          kind: 'dm_deadline',
          userWawuId: dm.creatorWawuId,
          hoursLeft: (dm.deadlineAt.getTime() - now) / (60 * 60 * 1000),
        }),
      ),
    );
    this.logger.log(`Reminded ${written} creator(s) of a closing paid-DM deadline.`);
  }

  /**
   * Sweep charge attempts that were initiated but never verified. These are
   * abandoned checkouts; keeping them forever would let a stale tx_ref be
   * verified long after the fact.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'sweep-pending-charges' })
  async sweepStalePendingCharges(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.pendingCharge.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Swept ${count} abandoned charge attempt(s) older than 24h.`);
    }
  }
}
