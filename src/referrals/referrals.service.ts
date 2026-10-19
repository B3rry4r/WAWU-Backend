import { Inject, Injectable } from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { PrismaService } from '../common/prisma/prisma.service';
import { loadMoneyParties } from '../money/money-party';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import {
  PLANS_CONFIG,
  tierById,
  type PlansConfig,
} from '../plans/plans-config';
import { codeCandidate, nameStem, normalizeCode } from './referral-code';
import {
  REFERRAL_CODE,
  REFERRAL_LINK_PREFIX,
  REFERRAL_VIEW,
} from './referral-config';
import { ReferralError } from './referral-error';
import {
  levelsReached,
  MILLI,
  multiplierMilliFor,
  nextMilestone,
} from './referral-ladder';
import { lockPair } from './referral-lock';
import type {
  ClaimReferralView,
  MyReferralsView,
  ReferralRewardStateName,
  ReferralRewardView,
} from './referral-view.type';

const DAY_MS = 86_400_000;

const STATE_NAME = {
  pending: 'pending',
  granted: 'available',
  cancelled: 'cancelled',
} as const satisfies Record<string, ReferralRewardStateName>;

/**
 * A person's referral code, the claim of someone else's, and the figures of
 * RF1 to RF4 (task REF-02, R-43, R-65).
 *
 * - **One code per person**, made the first time they ask for it (their first
 *   name, else a number added, else random) and never changed. The link is
 *   `wawu/r/<code>`.
 * - **A claim** is once per person, within the setting's days of sign-up
 *   (`referral.claim_days`), before they have paid for a tier, never their
 *   own code, and never the code of someone they invited. One level only:
 *   only the person whose code was used can earn from them.
 * - **Nothing here waits on a network while a transaction is open.** The
 *   claim is two short database statements under a lock; the view reads the
 *   database and then asks WAWU ID for names once, holding nothing.
 */
@Injectable()
export class ReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly settings: PlanSettingsService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /** RF1: the link, the counts, the level, the next milestone, the newest rewards. */
  async view(user: WawuJwtClaims): Promise<MyReferralsView> {
    const me = user.sub;
    const code = await this.ensureCode(me, user.firstName);
    const plan = this.config.referral;

    const [brought, byState, milestoneRows, rewardRows] = await Promise.all([
      this.prisma.personReferral.count({ where: { referrerWawuUserId: me } }),
      this.prisma.referralReward.groupBy({
        by: ['state'],
        where: { referrerWawuUserId: me },
        _count: { _all: true },
        _sum: { points: true },
      }),
      this.prisma.referralMilestone.findMany({
        where: { referrerWawuUserId: me },
        orderBy: { count: 'asc' },
      }),
      this.prisma.referralReward.findMany({
        where: { referrerWawuUserId: me },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: REFERRAL_VIEW.rewards,
      }),
    ]);
    const of = (state: 'pending' | 'granted') => {
      const row = byState.find((s) => s.state === state);
      return { count: row?._count._all ?? 0, points: row?._sum.points ?? 0 };
    };
    const granted = of('granted');
    const pending = of('pending');
    const verified = granted.count;
    const milestonePoints = milestoneRows.reduce((n, m) => n + m.points, 0);
    const reachedAt = new Map(milestoneRows.map((m) => [m.count, m.grantedAt]));

    const parties = await loadMoneyParties(this.prisma, this.wawuId, [
      ...new Set(rewardRows.map((r) => r.referredWawuUserId)),
    ]);
    const rewards: ReferralRewardView[] = rewardRows.map((r) => ({
      id: r.id,
      name: parties.get(r.referredWawuUserId)?.displayName ?? '',
      tierId: r.tierId,
      tierName: tierById(this.config, r.tierId)?.name ?? r.tierId,
      basePoints: r.basePoints,
      multiplier: r.multiplierMilli / MILLI,
      points: r.points,
      state: STATE_NAME[r.state],
      availableAt: r.availableAt.toISOString(),
      settledAt: r.settledAt?.toISOString() ?? null,
    }));

    const next = nextMilestone(plan.milestones, verified);
    return {
      link: `${REFERRAL_LINK_PREFIX}${code.toLowerCase()}`,
      code,
      brought,
      verified,
      pending: pending.count,
      pointsEarned: granted.points + milestonePoints,
      pendingPoints: pending.points,
      multiplier: multiplierMilliFor(plan.levels, verified) / MILLI,
      level: levelsReached(plan.levels, verified),
      ladder: plan.levels.map((l) => ({
        verified: l.min,
        multiplier: l.x,
        reached: verified >= l.min,
      })),
      nextMilestone:
        next === null
          ? null
          : {
              verified: next.count,
              points: next.points,
              remaining: next.count - verified,
            },
      milestones: [...plan.milestones]
        .sort((a, b) => a.count - b.count)
        .map((m) => ({
          verified: m.count,
          points: m.points,
          reached: reachedAt.has(m.count),
          grantedAt: reachedAt.get(m.count)?.toISOString() ?? null,
        })),
      holdDays: plan.holdDays,
      claimDays: this.settings.number('referral.claim_days'),
      rewards,
    };
  }

  /**
   * Uses someone's code. Once per person; the same code again answers the
   * first claim unchanged, a different one is `referral_already_claimed`.
   */
  async claim(wawuUserId: string, raw: string): Promise<ClaimReferralView> {
    const code = normalizeCode(raw);
    const owner =
      code === null
        ? null
        : await this.prisma.personReferralCode.findUnique({ where: { code } });
    if (code === null || owner === null)
      throw new ReferralError(
        'referral_code_unknown',
        'That code does not match anyone. Check it and try again.',
      );
    if (owner.wawuUserId === wawuUserId)
      throw new ReferralError(
        'referral_own_code',
        'That is your own code. Share it with someone new instead.',
      );

    const existing = await this.claimOf(wawuUserId);
    if (existing !== null) return this.sameOrRefuse(existing, code);

    const claimDays = this.settings.number('referral.claim_days');
    const [profile, paid] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { createdAt: true },
      }),
      this.prisma.makerPurchase.findFirst({
        where: { wawuUserId, status: 'paid' },
        select: { paymentRef: true },
      }),
    ]);
    if (
      profile !== null &&
      Date.now() > profile.createdAt.getTime() + claimDays * DAY_MS
    )
      throw new ReferralError(
        'referral_claim_closed',
        `A code can be used in the first ${claimDays} days after you sign up.`,
        { claimDays },
      );
    if (paid !== null)
      throw new ReferralError(
        'referral_not_new',
        'A code can only be used before you buy a plan.',
      );

    const made = await this.prisma.$transaction(async (tx) => {
      await lockPair(tx, wawuUserId, owner.wawuUserId);
      const invitedByMe = await tx.personReferral.findFirst({
        where: {
          referrerWawuUserId: wawuUserId,
          referredWawuUserId: owner.wawuUserId,
        },
        select: { id: true },
      });
      if (invitedByMe !== null)
        throw new ReferralError(
          'referral_loop',
          'That code belongs to someone you invited.',
        );
      const { count } = await tx.personReferral.createMany({
        data: [
          {
            referrerWawuUserId: owner.wawuUserId,
            referredWawuUserId: wawuUserId,
            code,
          },
        ],
        skipDuplicates: true,
      });
      return count === 1;
    });
    const row = await this.claimOf(wawuUserId);
    if (row === null) throw new Error('A claim that was just made is missing.');
    return made ? this.claimView(row) : this.sameOrRefuse(row, code);
  }

  /** The person's own code, made now if they have none. */
  async ensureCode(
    wawuUserId: string,
    firstName: string | null,
  ): Promise<string> {
    const have = await this.prisma.personReferralCode.findUnique({
      where: { wawuUserId },
      select: { code: true },
    });
    if (have !== null) return have.code;
    const stem = nameStem(firstName);
    for (let attempt = 0; attempt < REFERRAL_CODE.nameAttempts + 5; attempt++) {
      const code = codeCandidate(stem, attempt);
      // A code a /join registration link already uses is never handed out (REF-01).
      const taken = await this.prisma.referralCode.findFirst({
        where: { code: { equals: code, mode: 'insensitive' } },
        select: { id: true },
      });
      if (taken !== null) continue;
      await this.prisma.personReferralCode.createMany({
        data: [{ wawuUserId, code }],
        skipDuplicates: true,
      });
      // Either this call made it, another call for the same person did, or
      // the code belongs to someone else (then the person still has none).
      const mine = await this.prisma.personReferralCode.findUnique({
        where: { wawuUserId },
        select: { code: true },
      });
      if (mine !== null) return mine.code;
    }
    throw new Error('No free referral code could be made.');
  }

  private claimOf(referredWawuUserId: string) {
    return this.prisma.personReferral.findUnique({
      where: { referredWawuUserId },
    });
  }

  private sameOrRefuse(
    row: { code: string; claimedAt: Date },
    code: string,
  ): ClaimReferralView {
    if (row.code === code) return this.claimView(row);
    throw new ReferralError(
      'referral_already_claimed',
      'You have already used a code.',
    );
  }

  private claimView(row: { code: string; claimedAt: Date }): ClaimReferralView {
    return { code: row.code, claimedAt: row.claimedAt.toISOString() };
  }
}
