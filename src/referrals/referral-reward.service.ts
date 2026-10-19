import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { daysInMonths } from '../plan-settings/plan-setting-registry';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { PointsService } from '../points/points.service';
import { REFERRAL_SWEEP } from './referral-config';
import { multiplierMilliFor, rewardPoints } from './referral-ladder';
import { lockReferrer } from './referral-lock';

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;

/** Why a reward will never be paid. Stored on the row, never shown as it is. */
export type ReferralCancelReason =
  'purchase_refunded' | 'referrer_no_tier' | 'no_points';

/** What `onTierPaid` found. */
export type TierPaidOutcome =
  /** The person was not invited, has no paid tier, or the reward already exists. */
  | 'none'
  /** A reward was made and is held. */
  | 'pending'
  /** A reward row was made already cancelled (the referrer holds no tier, or the tier earns nothing). */
  | 'cancelled';

export interface ReleaseOutcome {
  /** Rewards that became the referrer's points. */
  granted: number;
  /** Rewards cancelled at the end of the hold. */
  cancelled: number;
  /** Rewards the pass could not settle; each is logged and tried again. */
  failed: number;
}

/**
 * The rewards of referral points (task REF-02, R-43, R-65).
 *
 * - **Made once.** When an invited person's first tier payment is granted
 *   (`onTierPaid`, called by the purchase after it commits and by the job's
 *   catch-up pass for one it missed), one reward row is inserted. The row's
 *   `referralId` is unique and the insert skips a duplicate, so parallel tier
 *   payments and repeated confirmations make exactly one, and the first one
 *   in decides the tier it rests on (the person's earliest paid purchase).
 * - **Held, then paid.** The reward is `pending` for the plan's hold days.
 *   The job (`release`) then settles it under the referrer's lock: cancelled
 *   if the purchase was refunded inside the hold or the referrer held no
 *   tier, else `granted` with its points added through POINTS-01 (source
 *   `referral`, reference `reward:<id>`, last in the transaction), and the
 *   milestones the new count reaches, each once.
 * - **Nothing waits on a network.** Every step is the Hub's own database. The
 *   one transaction is short and holds the referrer's lock and then the
 *   points lock, in that order only.
 * - **Figures are the live plan's.** Base points, multipliers, milestones,
 *   hold days and the points' life are admin settings (TIER-06); a reward
 *   copies its own figures when it is made.
 *
 * Referral pays points, never cash: no money, no split and no provider is
 * involved (R-43).
 */
@Injectable()
export class ReferralRewardService {
  private readonly logger = new Logger(ReferralRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly settings: PlanSettingsService,
    private readonly points: PointsService,
  ) {}

  /**
   * An invited person's tier payment was granted: make the reward for their
   * first one. Safe to call for anyone, any number of times, in parallel.
   */
  async onTierPaid(
    referredWawuUserId: string,
    now: Date = new Date(),
  ): Promise<TierPaidOutcome> {
    const referral = await this.prisma.personReferral.findUnique({
      where: { referredWawuUserId },
      select: {
        id: true,
        referrerWawuUserId: true,
        reward: { select: { id: true } },
      },
    });
    if (referral === null || referral.reward !== null) return 'none';
    const first = await this.prisma.makerPurchase.findFirst({
      where: { wawuUserId: referredWawuUserId, status: 'paid' },
      orderBy: [{ createdAt: 'asc' }, { paymentRef: 'asc' }],
      select: { paymentRef: true, tierId: true },
    });
    if (first === null) return 'none';

    const plan = this.config.referral;
    const referrerTier = await this.prisma.makerTier.findUnique({
      where: { wawuUserId: referral.referrerWawuUserId },
      select: { activeFrom: true, activeUntil: true },
    });
    const verified = await this.prisma.referralReward.count({
      where: {
        referrerWawuUserId: referral.referrerWawuUserId,
        state: 'granted',
      },
    });
    const multiplierMilli = multiplierMilliFor(plan.levels, verified);
    const basePoints = plan.basePoints[first.tierId] ?? 0;
    const points = rewardPoints(basePoints, multiplierMilli);
    let cancelReason: ReferralCancelReason | null = null;
    if (plan.referrerMustBeVerified && !holdsTierAt(referrerTier, now))
      cancelReason = 'referrer_no_tier';
    else if (points < 1) cancelReason = 'no_points';

    const { count } = await this.prisma.referralReward.createMany({
      data: [
        {
          referralId: referral.id,
          referrerWawuUserId: referral.referrerWawuUserId,
          referredWawuUserId,
          paymentRef: first.paymentRef,
          tierId: first.tierId,
          basePoints,
          multiplierMilli,
          points,
          state: cancelReason === null ? 'pending' : 'cancelled',
          availableAt: new Date(now.getTime() + plan.holdDays * DAY_MS),
          settledAt: cancelReason === null ? null : now,
          cancelReason,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return 'none';
    return cancelReason === null ? 'pending' : 'cancelled';
  }

  /**
   * Cancels the pending reward that rests on a refunded tier payment. For a
   * refund path to call; `release` also looks for the refund itself, so a
   * refund nobody told us about still cancels at the end of the hold. A
   * reward that is no longer pending is left as it is (points already paid
   * stay paid). True when a reward was cancelled.
   */
  async cancelForPurchase(
    paymentRef: string,
    reason: ReferralCancelReason = 'purchase_refunded',
    now: Date = new Date(),
  ): Promise<boolean> {
    const reward = await this.prisma.referralReward.findFirst({
      where: { paymentRef, state: 'pending' },
      select: { id: true, referrerWawuUserId: true },
    });
    if (reward === null) return false;
    return this.prisma.$transaction(async (tx) => {
      await lockReferrer(tx, reward.referrerWawuUserId);
      const { count } = await tx.referralReward.updateMany({
        where: { id: reward.id, state: 'pending' },
        data: { state: 'cancelled', settledAt: now, cancelReason: reason },
      });
      return count === 1;
    });
  }

  /**
   * Settles the rewards whose hold has ended, soonest first, at most
   * `REFERRAL_SWEEP.batch` a pass. A reward that fails is logged and left
   * pending for the next pass.
   */
  async release(
    now: Date = new Date(),
    batch: number = REFERRAL_SWEEP.batch,
  ): Promise<ReleaseOutcome> {
    const due = await this.prisma.referralReward.findMany({
      where: { state: 'pending', availableAt: { lte: now } },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: batch,
      select: { id: true, referrerWawuUserId: true },
    });
    const out: ReleaseOutcome = { granted: 0, cancelled: 0, failed: 0 };
    for (const r of due) {
      try {
        const result = await this.settle(r.id, r.referrerWawuUserId, now);
        if (result === 'granted') out.granted += 1;
        else if (result === 'cancelled') out.cancelled += 1;
      } catch (e) {
        out.failed += 1;
        this.logger.error(
          `referral reward ${r.id}: could not be settled, it stays pending (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
      }
    }
    return out;
  }

  /**
   * Makes the reward for an invited person whose tier payment was granted
   * while the hook was not called (a restart between the commit and the
   * call). Looks at the oldest referrals with no reward whose invited person
   * has a paid tier. Returns how many rewards it made.
   */
  async catchUp(
    now: Date = new Date(),
    batch: number = REFERRAL_SWEEP.reconcileBatch,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      Array<{ referredWawuUserId: string }>
    >`
      SELECT r."referredWawuUserId"
      FROM "PersonReferral" r
      WHERE NOT EXISTS (
          SELECT 1 FROM "ReferralReward" w WHERE w."referralId" = r."id")
        AND EXISTS (
          SELECT 1 FROM "MakerPurchase" p
          WHERE p."wawuUserId" = r."referredWawuUserId" AND p."status" = 'paid')
      ORDER BY r."claimedAt" ASC
      LIMIT ${batch}`;
    let made = 0;
    for (const row of rows) {
      try {
        if ((await this.onTierPaid(row.referredWawuUserId, now)) !== 'none')
          made += 1;
      } catch (e) {
        this.logger.error(
          `referral catch-up for ${row.referredWawuUserId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return made;
  }

  /**
   * One reward, in one short transaction: the referrer's lock first, then the
   * reward is read again (another server may have settled it), then it is
   * cancelled or granted. The points are the last writes.
   */
  private async settle(
    rewardId: string,
    referrerWawuUserId: string,
    now: Date,
  ): Promise<'granted' | 'cancelled' | 'skipped'> {
    return this.prisma.$transaction(async (tx) => {
      await lockReferrer(tx, referrerWawuUserId);
      const reward = await tx.referralReward.findUnique({
        where: { id: rewardId },
      });
      if (
        reward === null ||
        reward.state !== 'pending' ||
        reward.availableAt.getTime() > now.getTime()
      )
        return 'skipped';

      const why = await this.cancelReasonAtEnd(tx, reward);
      if (why !== null) {
        await tx.referralReward.update({
          where: { id: reward.id },
          data: { state: 'cancelled', settledAt: now, cancelReason: why },
        });
        return 'cancelled';
      }

      await tx.referralReward.update({
        where: { id: reward.id },
        data: { state: 'granted', settledAt: now },
      });
      const verified = await tx.referralReward.count({
        where: { referrerWawuUserId, state: 'granted' },
      });
      const grants: Array<{ sourceRef: string; points: number }> = [
        { sourceRef: `reward:${reward.id}`, points: reward.points },
      ];
      for (const m of this.config.referral.milestones) {
        if (m.count > verified) continue;
        const { count } = await tx.referralMilestone.createMany({
          data: [
            {
              referrerWawuUserId,
              count: m.count,
              points: m.points,
              grantedAt: now,
            },
          ],
          skipDuplicates: true,
        });
        if (count === 1)
          grants.push({
            sourceRef: `milestone:${referrerWawuUserId}:${m.count}`,
            points: m.points,
          });
      }
      const expiresAt = new Date(
        now.getTime() +
          daysInMonths(this.settings.number('points.expiry_months')) * DAY_MS,
      );
      // The points are the last writes of the transaction (POINTS-01).
      for (const g of grants)
        await this.points.grant(
          {
            wawuUserId: referrerWawuUserId,
            source: 'referral',
            sourceRef: g.sourceRef,
            points: g.points,
            expiresAt,
          },
          { tx, now },
        );
      return 'granted';
    });
  }

  /**
   * Why the reward must not be paid at the end of its hold, or null: the
   * tier payment it rests on was refunded (the purchase is no longer `paid`,
   * the payment was reversed, or a refund hold was written for it), or the
   * referrer held no tier when the hold ended ("Only a referrer with an
   * active tier earns").
   */
  private async cancelReasonAtEnd(
    tx: Tx,
    reward: {
      paymentRef: string;
      referrerWawuUserId: string;
      availableAt: Date;
    },
  ): Promise<ReferralCancelReason | null> {
    const purchase = await tx.makerPurchase.findUnique({
      where: { paymentRef: reward.paymentRef },
      select: { status: true },
    });
    if (purchase === null || purchase.status !== 'paid')
      return 'purchase_refunded';
    const [hold, payment] = await Promise.all([
      tx.walletHold.findUnique({
        where: { paymentId: reward.paymentRef },
        select: { id: true },
      }),
      tx.walletPayment.findUnique({
        where: { id: reward.paymentRef },
        select: { status: true },
      }),
    ]);
    if (hold !== null || payment?.status === 'reversed')
      return 'purchase_refunded';
    if (this.config.referral.referrerMustBeVerified) {
      const tier = await tx.makerTier.findUnique({
        where: { wawuUserId: reward.referrerWawuUserId },
        select: { activeFrom: true, activeUntil: true },
      });
      if (!holdsTierAt(tier, reward.availableAt)) return 'referrer_no_tier';
    }
    return null;
  }
}

/** The person held a running tier at that moment. */
function holdsTierAt(
  tier: { activeFrom: Date; activeUntil: Date } | null,
  at: Date,
): boolean {
  return (
    tier !== null &&
    tier.activeFrom.getTime() <= at.getTime() &&
    tier.activeUntil.getTime() > at.getTime()
  );
}
