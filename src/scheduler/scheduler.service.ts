import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

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

    const lapsed = await this.prisma.creatorSubscription.updateMany({
      where: { status: 'active', currentPeriodEnd: { lt: now } },
      data: { status: 'past_due' },
    });

    if (lapsed.count > 0) {
      this.logger.log(`Marked ${lapsed.count} subscription(s) past_due at period end.`);
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
