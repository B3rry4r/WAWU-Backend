import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { NotificationService } from '../../notification/notification.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { objectKeyFrom, StorageService } from '../../storage/storage.service';
import { PublishingAllowanceService } from '../../plans/publishing-allowance.service';
import { ProfileLocationService } from '../../geo/profile-location.service';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type { ContentPieceModel } from '../../../generated/prisma/models';
import type { AdminUserView } from '../auth/admin-user-view.type';
import {
  toAdminContentReviewEntryView,
  type AdminContentCreatorView,
  type AdminContentAssetsView,
  type AdminContentDecisionView,
  type AdminContentDetailView,
  type AdminContentQueueItemView,
} from './admin-content-view.type';
import type { AdminContentQueueQueryDto } from './dto/admin-content-queue-query.dto';
import type { RejectContentDto } from './dto/reject-content.dto';
import type { TakeDownContentDto } from './dto/take-down-content.dto';

/** Sensitive documents are handed out on the shortest URL StorageService offers. */
const SIGNED_URL_TTL_SECONDS = 900;

const MS_PER_HOUR = 3_600_000;

/**
 * How many times a decision reads the piece again when its status moved
 * between its read and its write (TIER-02 round 3, D5). Each pass is one
 * competing writer that got there first, so more than three in a row is not
 * a race but a fight over one piece, and the admin is asked to look again.
 */
const STATUS_ATTEMPTS = 3;

/**
 * The first writer of ContentPiece.status in this backend's history.
 *
 * Until this module existed, a ContentPiece was created `pending`
 * (content-piece.service.ts:418) and nothing anywhere ever moved it: the only
 * two `contentPiece.update` calls in the whole tree write `commentCount`
 * (comment.service.ts) and `ratingPct` (content-piece.service.ts), and the
 * `live` / `rejected` literals appear as READ filters and in prisma/seed.ts,
 * never as a write. Every public read path — feed, explore, search, public
 * profile, unlock — filters `status: 'live'`. So a creator paid ₦5,999–₦18,999
 * a year, burned an upload slot on create (an atomic increment with no
 * decrement anywhere), and published something no buyer could ever see.
 * Approving here is what makes the piece appear on those existing read paths;
 * nothing in them is modified.
 *
 * Everything this service touches outside its own audit table is a write it
 * cannot make additively: `ContentPiece.status` and `CreatorState.slotsUsed`
 * are existing columns whose VALUES change, which is the point of the
 * endpoints. No schema, DTO, route or service belonging to the app is
 * altered.
 */
@Injectable()
export class AdminContentReviewService {
  private readonly logger = new Logger(AdminContentReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly publishing: PublishingAllowanceService,
    // GEO-02. Optional only so the take-down spec, which builds this service by
    // hand with four arguments, still compiles; the app always provides it
    // (AdminContentReviewModule imports GeoModule).
    @Optional() private readonly places?: ProfileLocationService,
  ) {}

  /**
   * GET /admin/content/queue — everything waiting on a human, oldest first.
   *
   * Only `pending`. A queue that also listed live and rejected pieces would
   * make "how far behind are we" unanswerable, which is the one question it
   * exists to answer; the all-statuses browse is a separate screen (C2 in
   * .pipeline/derived-surface.json) and is deliberately not folded in here.
   */
  async queue(
    query: AdminContentQueueQueryDto,
  ): Promise<Paginated<AdminContentQueueItemView>> {
    const creatorsInPlace =
      (await this.places?.idsInPlace(query.countryCode, query.regionCode)) ??
      null;
    const where = {
      status: 'pending' as const,
      ...(creatorsInPlace !== null
        ? { creatorWawuId: { in: creatorsInPlace } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contentPiece.findMany({
        where,
        orderBy: { createdAt: query.sort === 'newest' ? 'desc' : 'asc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.contentPiece.count({ where }),
    ]);

    const creators = await this.resolveCreators(
      rows.map((r) => r.creatorWawuId),
    );
    const items = await Promise.all(
      rows.map(async (row) =>
        this.toQueueItem(row, creators.get(row.creatorWawuId)),
      ),
    );

    return { items, currentPage: query.page, perPage: query.perPage, total };
  }

  /** GET /admin/content/:id — any status, so a reviewer can reach a decision they already made. */
  async detail(id: string): Promise<AdminContentDetailView> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id },
    });
    if (!content) {
      throw new NotFoundException('Content not found.');
    }
    return this.toDetail(content);
  }

  /**
   * POST /admin/content/:id/approve — pending → live.
   *
   * Only from `pending`. Re-publishing a rejected piece is NOT this endpoint:
   * a rejection hands the creator's slot back (see `reject`), so a
   * rejected → live flip would have to re-claim a slot that may since have
   * been spent, and silently overselling a paid entitlement is worse than
   * asking the creator to resubmit through the upload flow they already have.
   */
  async approve(
    id: string,
    admin: AdminUserView,
  ): Promise<AdminContentDecisionView> {
    return this.decide(id, admin, 'approved', null);
  }

  /**
   * POST /admin/content/:id/reject — pending → rejected, reason required.
   *
   * ── THE UPLOAD SLOT ──────────────────────────────────────────────────────
   * A rejection RETURNS the slot: CreatorState.slotsUsed is decremented in the
   * same transaction as the status flip.
   *
   * Why, given the slot has never been decremented anywhere before: the
   * product already promises it. The web app's publishing wizard tells the
   * creator "if it is rejected the slot comes back", and ContentLibrary
   * computes the slot gauge as `items.filter(i => i.status !== 'rejected')`
   * (WAWU-Web src/components/create/ContentLibrary.tsx:78-81). So the app and
   * the database disagree today, and of the two coherent ways to settle it,
   * one charges a creator a year-long paid entitlement for a moderation
   * decision they did not control. That is the ratchet, not the fix.
   *
   * Decremented conditionally (`slotsUsed: { gt: 0 }`) and inside the same
   * transaction as the status change, so it cannot go negative and cannot
   * happen twice: the status flip itself is a conditional updateMany on
   * `status: 'pending'`, so two reviewers rejecting the same piece at the same
   * moment produce exactly one decrement. Whether the slot actually came back
   * is recorded on the audit row (`slotReturned`) rather than inferred.
   *
   * KNOWN RESIDUAL, reported rather than fixed: ContentPieceService.create
   * counts a creator's per-kind allowance with
   * `contentPiece.count({ where: { creatorWawuId, accessType } })`, which
   * counts rejected rows too (content-piece.service.ts:352-360). The total cap
   * reads `slotsUsed` and is therefore fully restored by this decrement, but
   * the free/paid sub-cap is not. Correcting that means editing an existing
   * service, which this module is forbidden to do.
   */
  async reject(
    id: string,
    dto: RejectContentDto,
    admin: AdminUserView,
  ): Promise<AdminContentDecisionView> {
    return this.decide(id, admin, 'rejected', dto.reason.trim());
  }

  /**
   * POST /admin/content/:id/take-down — any non-removed status -> removed.
   *
   * The remediation path `decide()` cannot offer: that one only ever acts on
   * `pending`, because approve/reject exist to resolve a review that is
   * waiting on someone. A LIVE piece has nothing waiting on it, and
   * `deleteAccount()` (account.service.ts) only removes a creator's content
   * from the moment it runs forward — an account deleted before that fix
   * shipped left its pieces exactly where they were, live, with no creator
   * left to delete them and no pending review left to reject. This is the
   * one lever an admin has for that piece, or any other live piece that
   * needs to come down outside the review flow.
   *
   * Reuses the same status and the same slot-return rule
   * ContentPieceService.delete() uses for a creator's own delete, so an
   * admin takedown and a self-delete leave identical bookkeeping behind.
   */
  async takeDown(
    id: string,
    dto: TakeDownContentDto,
    admin: AdminUserView,
  ): Promise<AdminContentDecisionView> {
    const { content, review } = await this.prisma.$transaction(async (tx) => {
      for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt += 1) {
        // The status is read HERE, inside the transaction, and the flip below
        // is conditional on exactly the status read (TIER-02 round 3, D5).
        // This used to read before the transaction and flip on "not removed",
        // so the place was returned for a status that could have moved in
        // between: a piece an admin rejected a moment earlier (its place
        // already back) returned it a second time, and a piece the creator
        // sent again a moment earlier (a place taken) was removed without
        // giving it back. Now a request whose write changes no row reads the
        // piece again and acts on what is true, which is how
        // ContentPieceService.delete() settles the same race.
        const existing = await tx.contentPiece.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('Content not found.');
        }
        if (existing.status === 'removed') {
          throw new BadRequestException('This piece has already been removed.');
        }

        // Only a row still in the status just read is changed, and that
        // status is not `removed`, so a piece another request has already
        // removed never matches: one piece gives its place back once and
        // writes one audit row, however many requests remove it.
        const claimed = await tx.contentPiece.updateMany({
          where: { id, status: existing.status },
          data: { status: 'removed' },
        });
        if (claimed.count === 0) continue;

        // A rejected piece's place went back at the rejection. Any other
        // piece holds one. The status here is the one this write changed.
        let slotReturned = false;
        if (existing.status !== 'rejected') {
          const returned = await tx.creatorState.updateMany({
            where: {
              wawuUserId: existing.creatorWawuId,
              slotsUsed: { gt: 0 },
            },
            data: { slotsUsed: { decrement: 1 } },
          });
          slotReturned = returned.count > 0;
        }

        const reviewRow = await tx.adminContentReview.create({
          data: {
            contentId: id,
            creatorWawuId: existing.creatorWawuId,
            decision: 'removed',
            previousStatus: existing.status,
            newStatus: 'removed',
            reason: dto.reason.trim(),
            slotReturned,
            reviewedByAdminId: admin.id,
            reviewedByAdminEmail: admin.email,
            reviewedByAdminRole: admin.role,
          },
        });

        const updated = await tx.contentPiece.findUniqueOrThrow({
          where: { id },
        });
        return { content: updated, review: reviewRow };
      }
      throw new ConflictException(
        'This piece changed while you were taking it down. Try again.',
      );
    });

    return {
      content: await this.toDetail(content),
      review: toAdminContentReviewEntryView(review),
    };
  }

  private async decide(
    id: string,
    admin: AdminUserView,
    decision: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<AdminContentDecisionView> {
    const newStatus =
      decision === 'approved' ? ('live' as const) : ('rejected' as const);

    const { content, review } = await this.prisma.$transaction(async (tx) => {
      // The status is read inside the transaction, like take-down's
      // (TIER-02 round 3, D5), so what the audit row calls the previous
      // status is the status the flip below really changed. The flip is
      // conditional on `pending`, the one status a review can start from, so
      // a piece another request moved on (a second reviewer, a take-down, the
      // creator's own delete) never matches: of any number of requests, only
      // the one whose write changed the row moves the place and writes an
      // audit row.
      const existing = await tx.contentPiece.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException('Content not found.');
      }
      if (existing.status !== 'pending') {
        throw new BadRequestException(
          `Only a pending piece can be reviewed. This one is already ${existing.status}.`,
        );
      }

      const claimed = await tx.contentPiece.updateMany({
        where: { id, status: 'pending' },
        data: { status: newStatus },
      });
      if (claimed.count === 0) {
        throw new BadRequestException(
          'This piece was reviewed by someone else a moment ago.',
        );
      }

      // The slot ledger only moves on a rejection, and only downward from a
      // positive value. `updateMany` rather than `update` because a creator
      // with no CreatorState row must not turn a moderation decision into a
      // 500 — count 0 simply means nothing was returned, which is what the
      // audit row then records.
      let slotReturned = false;
      if (decision === 'rejected') {
        const returned = await tx.creatorState.updateMany({
          where: { wawuUserId: existing.creatorWawuId, slotsUsed: { gt: 0 } },
          data: { slotsUsed: { decrement: 1 } },
        });
        slotReturned = returned.count > 0;
      }

      const reviewRow = await tx.adminContentReview.create({
        data: {
          contentId: id,
          creatorWawuId: existing.creatorWawuId,
          decision,
          previousStatus: existing.status,
          newStatus,
          reason,
          slotReturned,
          // Email and role are snapshotted, not joined: "who approved this"
          // has to stay answerable after the admin is renamed or deleted.
          reviewedByAdminId: admin.id,
          reviewedByAdminEmail: admin.email,
          reviewedByAdminRole: admin.role,
        },
      });

      const updated = await tx.contentPiece.findUniqueOrThrow({
        where: { id },
      });
      return { content: updated, review: reviewRow };
    });

    // TELL THE CREATOR THEY WERE TURNED DOWN, and why.
    //
    // Emitted AFTER the transaction commits, deliberately: a notification for
    // a decision that then rolled back is worse than a late one, and emit()
    // swallows its own failures so it can never take the moderation write with
    // it.
    //
    // Nothing emitted this before. The kind was declared, the web client
    // rendered it, and grep found zero writers — so a creator's upload was
    // rejected, their slot returned, and the only signal was a number quietly
    // changing on a screen they had no reason to reopen. The reason the
    // reviewer is REQUIRED to type was written to an audit row only they could
    // read. Found during legacy-app-repair, 2026-08-31.
    if (decision === 'rejected') {
      await this.notifications.emit({
        kind: 'content_rejected',
        userWawuId: content.creatorWawuId,
        contentTitle: content.title,
        reason,
        // ME-10: "See why" opens the piece, where the reason is shown (M26).
        about: { target: { kind: 'content', id: content.id } },
      });
    }

    return {
      content: await this.toDetail(content),
      review: toAdminContentReviewEntryView(review),
    };
  }

  // ── views ────────────────────────────────────────────────────────────────

  private async toDetail(
    content: ContentPieceModel,
  ): Promise<AdminContentDetailView> {
    const [creators, lessons, completedPurchaseCount, history] =
      await Promise.all([
        this.resolveCreators([content.creatorWawuId]),
        this.prisma.courseLesson.findMany({
          where: { contentId: content.id },
          orderBy: { order: 'asc' },
        }),
        this.prisma.purchase.count({
          where: {
            contentId: content.id,
            type: 'content',
            status: 'completed',
          },
        }),
        this.prisma.adminContentReview.findMany({
          where: { contentId: content.id },
          orderBy: { reviewedAt: 'desc' },
        }),
      ]);

    return {
      ...(await this.toQueueItem(content, creators.get(content.creatorWawuId))),
      views: content.views,
      likes: content.likes,
      commentCount: content.commentCount,
      ratingPct: content.ratingPct,
      lessons: lessons.map((l) => ({
        id: l.id,
        title: l.title,
        order: l.order,
        durationLabel: l.durationLabel,
      })),
      completedPurchaseCount,
      reviewHistory: history.map(toAdminContentReviewEntryView),
    };
  }

  private async toQueueItem(
    content: ContentPieceModel,
    creator: AdminContentCreatorView | undefined,
  ): Promise<AdminContentQueueItemView> {
    return {
      id: content.id,
      slug: content.slug,
      title: content.title,
      description: content.description,
      category: content.category,
      tags: content.tags,
      contentType: content.contentType,
      accessType: content.accessType,
      price: content.price,
      durationLabel: content.durationLabel,
      pageCount: content.pageCount,
      status: content.status,
      creatorFirstUploadFree: content.creatorFirstUploadFree,
      createdAt: content.createdAt,
      waitingHours: Math.max(
        0,
        Math.floor((Date.now() - content.createdAt.getTime()) / MS_PER_HOUR),
      ),
      creator: creator ?? emptyCreatorView(content.creatorWawuId),
      assets: await this.signAssets(content),
    };
  }

  /**
   * Creator context for a set of pieces, in three batched reads rather than
   * per-row lookups.
   *
   * Every value is read from the row the app itself reads. `slotsTotal` is
   * what the publishing gate allows (TIER-02), read from the same
   * PublishingAllowanceService as CreatorStateService, and `kycStatus` reproduces that service's
   * `not_started` synthesis (protected-surface hazard H-5) — the reviewer must
   * see the same word the creator sees on their own screen, not a second
   * definition of it. Nothing here is written back.
   */
  private async resolveCreators(
    wawuUserIds: string[],
  ): Promise<Map<string, AdminContentCreatorView>> {
    const ids = [...new Set(wawuUserIds)];
    if (ids.length === 0) return new Map();

    const [profiles, states, submitted, allowances] = await Promise.all([
      this.prisma.userProfile.findMany({ where: { wawuUserId: { in: ids } } }),
      this.prisma.creatorState.findMany({ where: { wawuUserId: { in: ids } } }),
      this.prisma.kycSubmission.findMany({
        where: { wawuUserId: { in: ids } },
        select: { wawuUserId: true },
        distinct: ['wawuUserId'],
      }),
      this.publishing.ofMany(ids),
    ]);

    const profileById = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const stateById = new Map(states.map((s) => [s.wawuUserId, s]));
    const hasSubmitted = new Set(submitted.map((s) => s.wawuUserId));

    return new Map(
      ids.map((wawuUserId) => {
        const profile = profileById.get(wawuUserId);
        const state = stateById.get(wawuUserId);
        return [
          wawuUserId,
          {
            wawuUserId,
            handle: profile?.handle ?? null,
            accountType: profile?.accountType ?? null,
            kycStatus: state
              ? state.kycStatus === 'pending' && !hasSubmitted.has(wawuUserId)
                ? 'not_started'
                : state.kycStatus
              : null,
            slotsUsed: state?.slotsUsed ?? null,
            slotsTotal: state
              ? (allowances.get(wawuUserId)?.productsAllowed ?? null)
              : null,
          },
        ];
      }),
    );
  }

  // ── assets ───────────────────────────────────────────────────────────────

  /** GET /admin/content/:id/cover (CONTENT-COVER, R-114): the cover the piece is reviewed with, signed for 15 minutes. */
  async cover(id: string): Promise<{ coverUrl: string | null }> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id },
      select: { coverKey: true },
    });
    if (!content) throw new NotFoundException('Content not found');
    return { coverUrl: await this.signAsset(content.coverKey) };
  }

  /**
   * The bucket is private, so a reviewer cannot open a stored asset without a
   * signature. Both are signed with `StorageService.signedReadUrl(key, 900)` —
   * the SHORT-LIVED path, the same one KYC document reads use — never
   * `readUrlFor`, whose URLs live for seven days.
   *
   * The result is returned and then forgotten: never written to a row, never
   * put in the audit trail, never logged (the catch below logs the object KEY
   * and the error, deliberately not the URL — a signed URL is a bearer token
   * for the object, and a log line is a place it outlives the request).
   */
  private async signAssets(
    content: ContentPieceModel,
  ): Promise<AdminContentAssetsView> {
    const [previewUrl, fullUrl] = await Promise.all([
      this.signAsset(content.previewAssetUrl),
      this.signAsset(content.fullAssetUrl),
    ]);
    return { previewUrl, fullUrl, hasFullAsset: Boolean(content.fullAssetUrl) };
  }

  private async signAsset(stored: string | null): Promise<string | null> {
    if (!stored) return null;
    const key = objectKeyFrom(stored);
    try {
      return await this.storage.signedReadUrl(key, SIGNED_URL_TTL_SECONDS);
    } catch (e) {
      // Storage unconfigured or unreachable. The queue still has to render —
      // a reviewer with no video is a stalled review, a 500 is a dead screen.
      this.logger.warn(`Could not sign content asset ${key}: ${String(e)}`);
      return null;
    }
  }
}

/**
 * A piece whose creator has no UserProfile and no CreatorState row.
 *
 * Not an error and not hidden: the piece exists and still has to be reviewed.
 * Every field is null rather than a plausible default, so the dashboard shows
 * "unknown" instead of inventing a value.
 */
function emptyCreatorView(wawuUserId: string): AdminContentCreatorView {
  return {
    wawuUserId,
    handle: null,
    accountType: null,
    kycStatus: null,
    slotsUsed: null,
    slotsTotal: null,
  };
}
