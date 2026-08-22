import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import type { NotificationEvent } from '../notification/notification-event';

/**
 * The two time-based promises the product makes and previously could not keep.
 *
 * Nothing in this API ran on a schedule at all — no cron, no queue, no
 * webhook — so:
 *   1. A paid DM the creator never answered was never refunded, despite the
 *      24-hour guarantee shown to the sender at checkout. The money sat as
 *      `held` earnings forever and the creator effectively kept it.
 *   2. A subscription never charged again at `currentPeriodEnd`, so year two
 *      was free and a Pro creator's 10% commission rate persisted indefinitely.
 *
 * Both sweeps are idempotent and safe to run repeatedly: each one selects only
 * rows still in the state it acts on, and writes conditionally.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Refund paid DMs whose 24-hour reply window has passed unanswered.
   *
   * `deadlineAt` is set once at creation and never recomputed (registry
   * note), so this is a pure "past deadline and still awaiting" sweep. The
   * status flip is what stops the amount counting as held creator earnings
   * and is what the fan's thread renders as refunded.
   *
   * NOTE: this reverses the ENTITLEMENT. Moving the money back to the payer's
   * card additionally needs a Flutterwave refund call, which no adapter in
   * this codebase exposes yet — `refundedDms` is logged so those rows can be
   * reconciled by hand until it does.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'refund-expired-dms' })
  async refundExpiredDms(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.directMessage.findMany({
      where: { status: 'awaiting_response', deadlineAt: { lt: now } },
      select: { id: true, amount: true, senderWawuId: true },
      take: 500,
    });
    if (expired.length === 0) return;

    const result = await this.prisma.directMessage.updateMany({
      where: {
        id: { in: expired.map((d) => d.id) },
        // Re-checked in the write so a creator replying in the same instant
        // wins the race rather than being refunded out from under them.
        status: 'awaiting_response',
        deadlineAt: { lt: now },
      },
      data: { status: 'refunded' },
    });

    this.logger.log(
      `Refunded ${result.count} expired paid DM(s) — awaiting Flutterwave refund calls: ${expired
        .map((d) => d.id)
        .join(', ')}`,
    );

    // Tell the FAN their money is coming back. Read the rows again rather
    // than trusting the pre-update snapshot: a creator who replied in the
    // same instant wins the race (the status guard in the WHERE above), and
    // that DM must not be announced as refunded. Rows already `refunded`
    // are never re-selected by the sweep, so this cannot fire twice for the
    // same DM on a later run.
    const settled = await this.prisma.directMessage.findMany({
      where: { id: { in: expired.map((d) => d.id) }, status: 'refunded' },
      select: { amount: true, senderWawuId: true },
    });
    await this.notifications.emitMany(
      settled.map((dm) => ({
        kind: 'dm_refunded' as const,
        userWawuId: dm.senderWawuId,
        amount: dm.amount,
      })),
    );
  }

  /**
   * Mark subscriptions past their period end as `past_due`.
   *
   * Actually taking the renewal payment needs a stored Flutterwave customer
   * or card token to charge off-session; `flutterwaveCustomerRef` exists on
   * the model but nothing populates it yet, so attempting a charge here would
   * be inventing a capability. Flipping to `past_due` is the honest, useful
   * half: it revokes the paid tier's benefits at the right moment and drives
   * the existing in-app "your subscription needs attention" recovery flow
   * (POST /creator-subscription/retry-payment), instead of granting a free
   * second year in silence.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-subscriptions' })
  async expireLapsedSubscriptions(): Promise<void> {
    const now = new Date();

    // Selected before the write so the affected creators can be notified.
    // The status guard stays in the UPDATE's own WHERE, so a subscription
    // renewed in the same instant is not flipped out from under the creator
    // — and the notification list is re-derived from what actually changed.
    const lapsing = await this.prisma.creatorSubscription.findMany({
      where: { status: 'active', currentPeriodEnd: { lt: now } },
      select: { creatorWawuId: true, tier: true },
      take: 1000,
    });

    const lapsed = await this.prisma.creatorSubscription.updateMany({
      where: {
        creatorWawuId: { in: lapsing.map((s) => s.creatorWawuId) },
        status: 'active',
        currentPeriodEnd: { lt: now },
      },
      data: { status: 'past_due' },
    });

    if (lapsed.count > 0) {
      this.logger.log(`Marked ${lapsed.count} subscription(s) past_due at period end.`);

      // "Your subscription did not renew" — the one piece of billing news a
      // creator cannot afford to miss, because `subscriptionPaid` is cleared
      // a few lines below and their upload gate closes with it. Re-read so a
      // subscription that renewed in the race is not falsely warned.
      const confirmed = await this.prisma.creatorSubscription.findMany({
        where: {
          creatorWawuId: { in: lapsing.map((s) => s.creatorWawuId) },
          status: 'past_due',
        },
        select: { creatorWawuId: true, tier: true },
      });
      await this.notifications.emitMany(
        confirmed.map((sub) => ({
          kind: 'subscription_renewal' as const,
          userWawuId: sub.creatorWawuId,
          state: 'past_due' as const,
          tier: sub.tier,
        })),
      );
    }

    // A subscription the creator cancelled, once its paid term actually ends.
    const ended = await this.prisma.creatorSubscription.updateMany({
      where: {
        status: { in: ['active', 'past_due'] },
        cancelsAt: { not: null, lte: now },
      },
      data: { status: 'expired' },
    });

    if (ended.count > 0) {
      this.logger.log(`Expired ${ended.count} cancelled subscription(s).`);
    }

    // A lapsed subscription must not keep handing out the paid upload gate or
    // the Pro commission rate.
    //
    // Only `CreatorState.subscriptionPaid` is cleared. `UserProfile
    // .accountType` is deliberately left as 'creator' — per CLAUDE.md creator
    // is an ACCOUNT TYPE, not an earned tier, so a lapse closes the upload
    // gate without deleting the person's creator identity (handle, profile,
    // Create navigation). Nothing in this backend demotes an account.
    const stale = await this.prisma.creatorSubscription.findMany({
      where: { status: { in: ['past_due', 'expired'] } },
      select: { creatorWawuId: true },
      take: 1000,
    });
    if (stale.length > 0) {
      await this.prisma.creatorState.updateMany({
        where: {
          wawuUserId: { in: stale.map((s) => s.creatorWawuId) },
          subscriptionPaid: true,
        },
        data: { subscriptionPaid: false },
      });
    }
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
   * Warn a fan that their 7-day WAWU Credits trial ends tomorrow.
   *
   * Daily at a fixed hour over a 24-hour band, so every trial falls in
   * exactly one run's window — same no-extra-column reasoning as the DM
   * reminder above, but with an exact band rather than an approximate one.
   *
   * The credits figure is a COUNT and is written to `creditsCount`, never to
   * `amount`: WAWU Credits are not money, are not a balance, and are not
   * cashable (CLAUDE.md).
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM, { name: 'warn-credits-trial-ending' })
  async warnCreditsTrialEnding(): Promise<void> {
    const now = Date.now();
    const from = new Date(now + 24 * 60 * 60 * 1000);
    const to = new Date(now + 48 * 60 * 60 * 1000);

    const ending = await this.prisma.creditsState.findMany({
      where: { trialEndsAt: { gte: from, lt: to } },
      select: { userWawuId: true, creditBalance: true },
      take: 1000,
    });
    if (ending.length === 0) return;

    const written = await this.notifications.emitMany(
      ending.map(
        (state): NotificationEvent => ({
          kind: 'trial_ending',
          userWawuId: state.userWawuId,
          creditsCount: state.creditBalance,
        }),
      ),
    );
    this.logger.log(`Warned ${written} user(s) that their credits trial ends tomorrow.`);
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
