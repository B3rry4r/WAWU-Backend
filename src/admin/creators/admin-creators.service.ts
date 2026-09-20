import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorEarningsService } from '../../creator-earnings/creator-earnings.service';
import { uploadAllowanceFor } from '../../common/creator-allowance';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type { CreatorStateModel, UserProfileModel } from '../../../generated/prisma/models';
import type { ReviewStatus } from '../../../generated/prisma/enums';
import type {
  AdminCreatorDetailView,
  AdminCreatorGatesView,
  AdminCreatorListItemView,
  AdminCreatorVerificationView,
} from './admin-creator-view.type';
import type { AdminCreatorSearchQueryDto } from './dto/admin-creator-search-query.dto';

/** The safe KYC projection. BVN, NIN, national-ID, document URL and payout bank details are never selected. */
const KYC_SAFE_SELECT = {
  wawuUserId: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  rejectionReason: true,
} as const;

type KycSafeRow = {
  wawuUserId: string;
  status: ReviewStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
};

/**
 * Creator lookup — the screen an operator opens when a creator emails "I paid
 * and I cannot upload".
 *
 * Before this, there was nothing to open. `/creator` (creator state),
 * `/creator/state` and `/content/mine/earnings` are all self-scoped to
 * the caller's own token, so an operator holding a support ticket could not reach
 * a single one of the four tables that answer it.
 *
 * ── EVERY NUMBER HERE IS READ, NOT INVENTED ──────────────────────────────
 *  - `kycStatus` is the CreatorState column verbatim, the same one the
 *    earning path checks, so this screen and the creator's actual
 *    capabilities cannot disagree.
 *  - `not_started` reproduces `CreatorStateService`'s synthesis (hazard H-5)
 *    rather than inventing a fifth word for the same state.
 *  - `slotsTotal` is `uploadAllowanceFor()`, the shared helper, because it
 *    is derived and not stored.
 *  - earnings come from `CreatorEarningsService` — the very service that
 *    answers the creator's own screen — and are not recomputed here.
 *  - the verification tier is reported as "the last rung THIS backend
 *    approved", explicitly labelled `authority: 'wawu-id'`, because WAWU ID
 *    owns the badge and this backend stores no tier column.
 *
 * ── WHAT IS NEVER SELECTED ───────────────────────────────────────────────
 * BVN, NIN, national-ID equivalent, ID document URL, payout bank name and
 * payout account number. `KYC_SAFE_SELECT` above is the whole of what this
 * service reads from `KycSubmission`, so support — who is refused KYC
 * DOCUMENTS in `../kyc-review/` — can safely read a lifecycle word here.
 *
 * ── A NOTE ON THE TWO-STEP FILTERS ───────────────────────────────────────
 * `UserProfile` and `CreatorState` share `wawuUserId` but have no declared
 * Prisma relation, so a filter that spans both cannot be one query. Declaring
 * a relation would be a change to the protected schema, so the state-side
 * filter materialises its matching ids and intersects. That is a real bound —
 * it is a list of creator ids, not of users, and the endpoint is an internal
 * operator tool — and it is written here rather than hidden so the next person
 * knows what would need a relation to fix.
 */
@Injectable()
export class AdminCreatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly earnings: CreatorEarningsService,
  ) {}

  /**
   * GET /admin/creators — search and list.
   *
   * `q` matches handle (partial, case-insensitive) and wawuUserId (prefix).
   * It refuses an email or a phone number with an explanation rather than an
   * empty list — see `AdminCreatorSearchQueryDto` for why neither can be
   * supported from this backend's data.
   */
  async listCreators(
    query: AdminCreatorSearchQueryDto,
  ): Promise<Paginated<AdminCreatorListItemView>> {
    const stateScopedIds = await this.idsMatchingStateFilters(query);
    if (stateScopedIds !== null && stateScopedIds.length === 0) {
      return { items: [], currentPage: query.page, perPage: query.perPage, total: 0 };
    }

    const q = query.q?.trim();
    const where = {
      ...(q
        ? {
            OR: [
              // Partial and case-insensitive: an operator has "ada" from a
              // ticket, not `@adaEzeCreates` character-perfect.
              { handle: { contains: q, mode: 'insensitive' as const } },
              // Prefix rather than contains on the id: a wawuUserId is pasted
              // whole or pasted truncated, never matched from the middle.
              { wawuUserId: { startsWith: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(query.accountType ? { accountType: query.accountType } : {}),
      ...(stateScopedIds !== null ? { wawuUserId: { in: stateScopedIds } } : {}),
    };

    const orderBy =
      query.sort === 'handle'
        ? ([{ handle: 'asc' as const }, { createdAt: 'desc' as const }] as const)
        : ([{ createdAt: query.sort === 'oldest' ? ('asc' as const) : ('desc' as const) }] as const);

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.userProfile.findMany({
        where,
        orderBy: [...orderBy],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.userProfile.count({ where }),
    ]);

    const items = await this.toListItems(profiles);
    return { items, currentPage: query.page, perPage: query.perPage, total };
  }

  /**
   * GET /admin/creators/:wawuId — everything the support screen needs, in one
   * response, as clearly distinct fields.
   *
   * Opens for an account with no `UserProfile` row rather than 404ing. An
   * account with a CreatorState row and no profile is exactly the ticket this
   * screen exists for, because every CreatorAccountGuard reads `accountType`
   * off the profile and a missing one 403s them everywhere. It 404s only when
   * this backend has never heard of the id at all.
   */
  async creatorDetail(wawuUserId: string): Promise<AdminCreatorDetailView> {
    const [profile, state, latestKyc, verifications, pendingCount, liveCount] =
      await Promise.all([
        this.prisma.userProfile.findUnique({ where: { wawuUserId } }),
        this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
        this.prisma.kycSubmission.findFirst({
          where: { wawuUserId },
          orderBy: { submittedAt: 'desc' },
          select: KYC_SAFE_SELECT,
        }),
        this.prisma.verificationSubmission.findMany({
          where: { wawuUserId },
          orderBy: { submittedAt: 'desc' },
          select: { tier: true, status: true, submittedAt: true, reviewedAt: true },
        }),
        this.prisma.contentPiece.count({ where: { creatorWawuId: wawuUserId, status: 'pending' } }),
        this.prisma.contentPiece.count({ where: { creatorWawuId: wawuUserId, status: 'live' } }),
      ]);

    if (!profile && !state) {
      throw new NotFoundException('No account with that WAWU ID is known to this backend.');
    }

    // The same aggregate the creator's own /creator-earnings returns, from the
    // same service. Never recomputed here — see the class comment.
    const earnings = await this.earnings.getForCreator(wawuUserId);
    const allowance = state ? uploadAllowanceFor() : null;

    return {
      wawuUserId,
      handle: profile?.handle ?? null,
      accountType: profile?.accountType ?? null,
      createdAt: profile?.createdAt ?? null,
      gates: toGatesView(state, latestKyc),
      verification: toVerificationView(verifications),
      uploads: {
        slotsUsed: state?.slotsUsed ?? null,
        slotsTotal: allowance?.total ?? null,
        pendingReviewCount: pendingCount,
        liveCount,
      },
      earnings: { total: earnings.total, payable: earnings.payable, held: earnings.held },
      directMessages: { enabled: state?.dmEnabled ?? null, price: state?.dmPrice ?? null },
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The wawuUserIds matching the CreatorState-side filters, or null when none
   * were supplied (meaning "do not constrain by state at all").
   *
   * `not_started` is the interesting one: it is a synthesized state, not a
   * stored value (hazard H-5), so it is expressed the way the synthesis
   * defines it — `kycStatus = pending` AND no KycSubmission row has ever
   * existed for the account. A filter that could not express it would put
   * "never submitted" and "waiting on a reviewer" in one bucket, which is the
   * difference between chasing the creator and chasing a reviewer.
   */
  private async idsMatchingStateFilters(
    query: AdminCreatorSearchQueryDto,
  ): Promise<string[] | null> {
    const hasStateFilter = query.kycStatus !== undefined;
    if (!hasStateFilter) return null;

    const notStarted = query.kycStatus === 'not_started';
    const submitterIds = notStarted
      ? (
          await this.prisma.kycSubmission.findMany({
            select: { wawuUserId: true },
            distinct: ['wawuUserId'],
          })
        ).map((row) => row.wawuUserId)
      : [];

    // `not_started` is not a stored value, so it cannot go into the WHERE as
    // itself — it becomes the pair of conditions the synthesis is defined by.
    const kycWhere = notStarted
      ? { kycStatus: 'pending' as const, wawuUserId: { notIn: submitterIds } }
      : query.kycStatus !== undefined
        ? { kycStatus: query.kycStatus as ReviewStatus }
        : {};

    const rows = await this.prisma.creatorState.findMany({
      where: kycWhere,
      select: { wawuUserId: true },
    });

    return rows.map((row) => row.wawuUserId);
  }

  /**
   * Turns a page of profiles into list rows in batched reads rather than
   * per-row lookups — the same shape `AdminContentReviewService.resolveCreators`
   * uses for the same reason.
   */
  private async toListItems(profiles: UserProfileModel[]): Promise<AdminCreatorListItemView[]> {
    const ids = profiles.map((p) => p.wawuUserId);
    if (ids.length === 0) return [];

    const [states, kycRows] = await Promise.all([
      this.prisma.creatorState.findMany({ where: { wawuUserId: { in: ids } } }),
      this.prisma.kycSubmission.findMany({
        where: { wawuUserId: { in: ids } },
        orderBy: { submittedAt: 'desc' },
        select: KYC_SAFE_SELECT,
      }),
    ]);

    const stateById = new Map(states.map((s) => [s.wawuUserId, s]));
    // findMany is ordered newest-first, so the first row seen per user IS the
    // latest submission.
    const latestKycById = new Map<string, KycSafeRow>();
    for (const row of kycRows) {
      if (!latestKycById.has(row.wawuUserId)) latestKycById.set(row.wawuUserId, row);
    }

    return profiles.map((profile) => {
      const state = stateById.get(profile.wawuUserId) ?? null;
      return {
        wawuUserId: profile.wawuUserId,
        handle: profile.handle,
        accountType: profile.accountType,
        gates: toGatesView(state, latestKycById.get(profile.wawuUserId) ?? null),
        createdAt: profile.createdAt,
      };
    });
  }
}

/**
 * The EARNING gate.
 *
 * There used to be two gates here. The upload gate was a paid subscription and
 * went with it; KYC is untouched and still decides whether a creator can be
 * paid.
 *
 * `kycStatus` reproduces `CreatorStateService`'s `not_started` synthesis
 * (hazard H-5): the column defaults to `pending`, so without this a creator who
 * has never submitted and a creator waiting on a reviewer read identically. The
 * creator already sees the distinction on their own screen; an operator seeing
 * a different word for the same state is how a support call goes wrong.
 */
export function toGatesView(
  state: CreatorStateModel | null,
  latestKyc: KycSafeRow | null,
): AdminCreatorGatesView {
  return {
    kycStatus: state
      ? state.kycStatus === 'pending' && latestKyc === null
        ? 'not_started'
        : state.kycStatus
      : null,
    kycSubmittedAt: latestKyc?.submittedAt ?? null,
    kycReviewedAt: latestKyc?.reviewedAt ?? null,
    kycRejectionReason: latestKyc?.status === 'rejected' ? latestKyc.rejectionReason : null,
  };
}

/**
 * The public trust badge, kept in its own block.
 *
 * Reported as "the last rung THIS backend approved", because that is the only
 * thing this backend truthfully knows: WAWU ID owns `verificationTier`, there
 * is no tier column here, and an approval is pushed over
 * `WawuIdClient.elevateVerificationTier`. `authority` says so on the wire so a
 * dashboard cannot render it as the source of truth.
 *
 * `TIER_ORDER` exists because "highest approved" is a ladder, not a timestamp:
 * a creator can hold Verified Business and later have a Certified Professional
 * application approved, and submissions are ordered by date, not by rung.
 */
const TIER_ORDER = [
  'basic',
  'verified_user',
  'verified_business',
  'certified_professional',
  'trusted_partner',
] as const;

export function toVerificationView(
  submissions: {
    tier: AdminCreatorVerificationView['approvedTier'];
    status: ReviewStatus;
    submittedAt: Date;
    reviewedAt: Date | null;
  }[],
): AdminCreatorVerificationView {
  let approved: (typeof submissions)[number] | null = null;
  for (const s of submissions) {
    if (s.status !== 'approved' || s.tier === null) continue;
    if (
      approved === null ||
      TIER_ORDER.indexOf(s.tier) > TIER_ORDER.indexOf(approved.tier as (typeof TIER_ORDER)[number])
    ) {
      approved = s;
    }
  }

  // Newest-first ordering from the caller, so the first pending row is the
  // application currently in front of a reviewer.
  const pending = submissions.find((s) => s.status === 'pending') ?? null;

  return {
    approvedTier: approved?.tier ?? null,
    approvedAt: approved?.reviewedAt ?? null,
    pendingTier: pending?.tier ?? null,
    authority: 'wawu-id',
  };
}
