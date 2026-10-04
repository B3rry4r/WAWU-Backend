import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  TICK_COLUMNS,
  TICK_UPLOADS,
  holdsTick,
  uploadAllowanceFor,
} from '../common/creator-allowance';
import { RANKING, type ContentSort } from './ranking';
import { Prisma } from '../../generated/prisma/client';
import type { ContentPieceModel as ContentPieceRow } from '../../generated/prisma/models';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { ContentPieceResponse } from '../common/types/content-piece.type';
import type { SavedItem } from '../common/types';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import type { CreateContentDto } from './dto/create-content.dto';
import type { RateContentDto } from './dto/rate-content.dto';
import { netOfCommission } from '../common/money';
import { NotificationService } from '../notification/notification.service';
import { StorageService } from '../storage/storage.service';
import type { VerifyUnlockDto } from './dto/verify-unlock.dto';
import type { UpdateContentDto } from './dto/update-content.dto';
import type { MyContentFilter } from './dto/my-content-query.dto';
import type { MyContentCounts, MyContentItem } from './dto/my-content.view';

/**
 * The commission rate, for every creator (conventions.md § Identity & format
 * canon). The 10% Pro rate went with the subscription that sold it; there is
 * no tier left to vary on.
 */
const STANDARD_COMMISSION_RATE = 0.15;

export interface FlutterwaveConfigResponse {
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
}

export interface UnlockVerifyResult {
  purchased: true;
  fullAssetUrl: string | null;
}

interface ContentRow {
  id: string;
  slug: string;
  creatorWawuId: string;
  contentType: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  accessType: string;
  price: number;
  durationLabel: string | null;
  pageCount: number | null;
  previewAssetUrl: string;
  fullAssetUrl: string | null;
  creatorFirstUploadFree: boolean;
  status: string;
  views: number;
  ratingPct: number | null;
  commentCount: number;
  likes: number;
  createdAt: Date;
}

/**
 * ContentPiece resource — registry.json "ContentPiece". Owns content
 * CRUD/listing, the unlock (paid-content purchase) flow, save-toggle, and
 * rating. Comment/CourseLesson/SavedItem's own contracted endpoints
 * (GET/POST .../comments, GET /users/me/saved) are separate resources
 * (wave 0, already built) — out of scope here per task brief § SCOPE.
 * POST/DELETE /content/:id/save ARE this resource's contract (registry
 * lists them under ContentPiece, not SavedItem — confirmed against
 * src/saved-item/saved-item.controller.ts's own doc comment, which
 * explicitly defers save/unsave to ContentPiece).
 */
@Injectable()
export class ContentPieceService {
  private readonly logger = new Logger(ContentPieceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Snapshotted at transaction time, never recomputed later (conventions.md).
   *
   * Still a method, and still called per transaction, because the snapshot is
   * the point: a rate change later must not move money already split. It
   * simply has nothing to look up any more.
   */
  private resolveCommissionRate(): number {
    return STANDARD_COMMISSION_RATE;
  }

  /**
   * `fullAssetLocked` (registry note: "derived") / `fullAssetUrl` (registry
   * note: "server-gated: present only if free or requester has completed
   * Purchase") are computed per-requester at read time here — never a
   * derived stored column, and never trusted from any client input.
   *
   * Both asset URLs are also RE-SIGNED here, not passed through as stored.
   * What gets persisted at upload time is `presignUpload().fileUrl` — an
   * already-signed URL good for 7 days — so a piece read any time after that
   * window served a dead link forever even though the object itself was
   * fine. StorageService.freshUrlFor recovers the key and signs a new one on
   * every read, the same fix already in place for the admin review queue
   * (admin-content-review.service.ts), just never applied to the surface
   * everyone actually watches content on.
   */
  private async toResponse(
    content: ContentRow,
    unlocked: boolean,
  ): Promise<ContentPieceResponse> {
    const isFree = content.accessType === 'free';
    const locked = !isFree && !unlocked;
    const [previewAssetUrl, fullAssetUrl] = await Promise.all([
      this.storage.freshUrlFor(content.previewAssetUrl),
      locked ? null : this.storage.freshUrlFor(content.fullAssetUrl),
    ]);
    return {
      ...content,
      previewAssetUrl: previewAssetUrl as string,
      fullAssetUrl,
      fullAssetLocked: locked,
    } as ContentPieceResponse;
  }

  /** Batch-resolves which of `contentIds` the requester has fully unlocked. */
  private async resolveUnlockedSet(
    requesterWawuId: string | undefined,
    contentIds: string[],
  ): Promise<Set<string>> {
    if (!requesterWawuId || contentIds.length === 0) return new Set();

    const [ownedAsCreator, completedPurchases] = await Promise.all([
      this.prisma.contentPiece.findMany({
        where: { id: { in: contentIds }, creatorWawuId: requesterWawuId },
        select: { id: true },
      }),
      this.prisma.purchase.findMany({
        where: {
          contentId: { in: contentIds },
          buyerWawuId: requesterWawuId,
          type: 'content',
          status: 'completed',
        },
        select: { contentId: true },
      }),
    ]);

    const unlocked = new Set<string>();
    for (const row of ownedAsCreator) unlocked.add(row.id);
    for (const row of completedPurchases)
      if (row.contentId) unlocked.add(row.contentId);
    return unlocked;
  }

  async findOne(
    id: string,
    requesterWawuId: string | undefined,
  ): Promise<ContentPieceResponse> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }
    // Removed is gone for everyone, owner included — there is no undelete,
    // so an owner-exception here would resurrect a piece nothing else can see.
    if (content.status === 'removed') {
      throw new NotFoundException('Content not found');
    }
    if (
      content.status !== 'live' &&
      content.creatorWawuId !== requesterWawuId
    ) {
      throw new NotFoundException('Content not found');
    }

    const unlockedSet = await this.resolveUnlockedSet(requesterWawuId, [
      content.id,
    ]);
    return this.toResponse(content, unlockedSet.has(content.id));
  }

  async list(
    requesterWawuId: string | undefined,
    scope: 'feed' | 'mine' | 'following' | undefined,
    category: string | undefined,
    page: number,
    perPage: number,
    sort: ContentSort = 'trending',
  ): Promise<Paginated<ContentPieceResponse>> {
    // Following (HOME-04): live pieces by the people the requester follows,
    // newest first. A follow edge is one row per (follower, creator), so
    // nobody the requester does not follow can appear, and unfollowing removes
    // a creator's pieces from the tab at the next read. Nobody signed out
    // follows anyone: an empty page, not an error.
    let followedIds: string[] = [];
    if (scope === 'following' && requesterWawuId) {
      const edges = await this.prisma.followRelationship.findMany({
        where: { followerWawuId: requesterWawuId },
        select: { followingWawuId: true },
      });
      followedIds = edges.map((e) => e.followingWawuId);
    }

    const where =
      scope === 'following'
        ? {
            status: 'live' as const,
            creatorWawuId: { in: followedIds },
            ...(category ? { category } : {}),
          }
        : scope === 'mine'
          ? {
              creatorWawuId: requesterWawuId ?? '__none__',
              // Registry note says "any status", written before `removed`
              // existed: a piece the creator deleted must disappear from their
              // own shelf immediately, same as everywhere else, or `delete()`
              // does nothing the creator can actually see.
              status: { not: 'removed' as const },
              ...(category ? { category } : {}),
            }
          : { status: 'live' as const, ...(category ? { category } : {}) };

    // "mine" is a creator looking at their own shelf, including drafts and
    // pieces still in review. That is a chronological list of their work, not
    // a ranked feed, so ranking is only applied to public browsing.
    const ranked =
      scope !== 'mine' && scope !== 'following' && sort !== 'recent';

    const chronological = () =>
      this.prisma.$transaction([
        this.prisma.contentPiece.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * perPage,
          take: perPage,
        }),
        this.prisma.contentPiece.count({ where }),
      ]);

    // Ranking is an ordering preference, not the feed itself. If the ranked
    // query fails the feed still has to render, so fall back to newest-first
    // and log it rather than 500ing the home screen.
    let items: ContentPieceRow[];
    let total: number;
    if (ranked) {
      try {
        [items, total] = await this.listRanked(category, sort, page, perPage);
      } catch (e) {
        this.logger.error(
          `Ranked feed query failed, falling back to newest-first: ${String(e)}`,
        );
        [items, total] = await chronological();
      }
    } else {
      [items, total] = await chronological();
    }

    const unlockedSet = await this.resolveUnlockedSet(
      requesterWawuId,
      items.map((i) => i.id),
    );
    return {
      items: await Promise.all(
        items.map((item) => this.toResponse(item, unlockedSet.has(item.id))),
      ),
      currentPage: page,
      perPage,
      total,
    };
  }

  /**
   * Ranked browse. Prisma cannot order by a computed expression, so the score
   * is evaluated in Postgres. Purchases are joined rather than denormalised
   * onto ContentPiece: a counter column would need every payment path to
   * remember to bump it, and one that silently drifts is worse than a join.
   *
   * `trending` decays by age; `top` is the same engagement score with no
   * decay, for an all-time leaderboard.
   */
  private async listRanked(
    category: string | undefined,
    sort: ContentSort,
    page: number,
    perPage: number,
  ): Promise<[ContentPieceRow[], number]> {
    // Every weight is cast to numeric. Postgres infers a bound parameter's type
    // from its context, so `c."views" * $n` typed the 0.1 view weight as an
    // integer and rejected it outright ("invalid input syntax for type integer:
    // 0.1"), which 500'd the whole feed.
    const engagement = Prisma.sql`(
      ${RANKING.base}::numeric
      + (c."likes" * ${RANKING.like}::numeric)
      + (c."commentCount" * ${RANKING.comment}::numeric)
      + (COALESCE(p."purchases", 0) * ${RANKING.purchase}::numeric)
      + (c."views" * ${RANKING.view}::numeric)
      + (COALESCE(c."ratingPct", 0)::numeric / ${RANKING.ratingDivisor}::numeric)
    )`;

    const score =
      sort === 'top'
        ? engagement
        : Prisma.sql`${engagement} / POWER(
            (EXTRACT(EPOCH FROM (NOW() - c."createdAt")) / 3600.0) + 2,
            ${RANKING.gravity}::numeric
          )`;

    const categoryFilter = category
      ? Prisma.sql`AND c."category" = ${category}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<ContentPieceRow[]>(Prisma.sql`
      SELECT c.*
      FROM "ContentPiece" c
      LEFT JOIN (
        SELECT "contentId", COUNT(*)::int AS purchases
        FROM "Purchase"
        WHERE "contentId" IS NOT NULL AND "status" = 'completed'
        GROUP BY "contentId"
      ) p ON p."contentId" = c."id"
      WHERE c."status" = 'live' ${categoryFilter}
      ORDER BY ${score} DESC, c."createdAt" DESC
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `);

    const total = await this.prisma.contentPiece.count({
      where: { status: 'live', ...(category ? { category } : {}) },
    });
    return [rows, total];
  }

  async listMine(
    creatorWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<ContentPieceResponse>> {
    return this.list(creatorWawuId, 'mine', undefined, page, perPage);
  }

  /**
   * A named creator's own published shelf — what GET /users/:wawuId/content
   * (UserProfileController) reads. Distinct from `listMine`: that one is
   * always the CALLER's own content in any status; this one is a THIRD
   * PARTY's content, so it is fixed to `status: 'live'` (a stranger never
   * sees a pending or rejected draft) regardless of who is asking.
   *
   * `requesterWawuId` still flows through to `resolveUnlockedSet` /
   * `toResponse`, so `fullAssetUrl` on a paid piece is locked unless THIS
   * caller purchased it — visiting someone else's profile never unlocks
   * their paid work.
   */
  async listByCreator(
    creatorWawuId: string,
    requesterWawuId: string | undefined,
    page: number,
    perPage: number,
  ): Promise<Paginated<ContentPieceResponse>> {
    const where = { creatorWawuId, status: 'live' as const };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.contentPiece.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.contentPiece.count({ where }),
    ]);

    const unlockedSet = await this.resolveUnlockedSet(
      requesterWawuId,
      items.map((i) => i.id),
    );
    return {
      items: await Promise.all(
        items.map((item) => this.toResponse(item, unlockedSet.has(item.id))),
      ),
      currentPage: page,
      perPage,
      total,
    };
  }

  /**
   * DELETE /content/:id — a creator removing their own piece.
   *
   * Never a hard delete: `Purchase.content` is `onDelete: Restrict` (see
   * that model's own comment), so `contentPiece.delete()` here would 500 the
   * instant one buyer existed. Setting `status: 'removed'` is the same
   * answer whether or not anyone bought it — no branch on purchase history
   * to get wrong.
   *
   * The slot ledger mirrors `AdminContentReviewService.reject()` exactly:
   * conditional decrement (`slotsUsed: { gt: 0 }`) in the same transaction,
   * and skipped for a piece that already occupies no slot. A `rejected`
   * piece already had its slot returned at review time (`occupiesASlot` in
   * `create()` never counted it); returning it again here would let one
   * upload free two slots.
   */
  async delete(id: string, requesterWawuId: string): Promise<void> {
    const existing = await this.prisma.contentPiece.findUnique({
      where: { id },
    });
    if (!existing || existing.status === 'removed') {
      throw new NotFoundException('Content not found');
    }
    if (existing.creatorWawuId !== requesterWawuId) {
      throw new ForbiddenException('You can only delete your own content.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.contentPiece.update({
        where: { id },
        data: { status: 'removed' },
      });

      if (existing.status !== 'rejected') {
        await tx.creatorState.updateMany({
          where: { wawuUserId: existing.creatorWawuId, slotsUsed: { gt: 0 } },
          data: { slotsUsed: { decrement: 1 } },
        });
      }
    });
  }

  private slugify(title: string): string {
    return (
      title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'content'
    );
  }

  async create(
    creatorWawuId: string,
    dto: CreateContentDto,
  ): Promise<ContentPieceResponse> {
    // No payment gate on uploading (build brief B1). CreatorAccountGuard on
    // POST /content has already proved this caller is a creator account, which
    // is the only thing that was ever checked here besides the subscription.
    //
    // The cap comes from whether the creator holds a tick now (R-7): 5 without
    // one, 25 with one. A free piece is allowed as the first upload or any
    // other, and claims a slot exactly like a paid one (R-8).
    const tickHeld = holdsTick(
      await this.prisma.userProfile.findUnique({
        where: { wawuUserId: creatorWawuId },
        select: TICK_COLUMNS,
      }),
    );
    const allowance = uploadAllowanceFor(tickHeld);

    // `previewAsset` is public by design — it is returned to every caller,
    // including anonymous ones on /content/public/featured. If it points at
    // the same object as `fullAsset`, the paywall is decorative: anyone can
    // read the preview URL and download the paid asset. Reject it rather
    // than silently shipping unlocked content.
    if (dto.accessType === 'paid' && dto.previewAsset === dto.fullAsset) {
      throw new BadRequestException(
        'Paid content needs a separate free preview — previewAsset must not be the same file as fullAsset.',
      );
    }
    if (dto.accessType === 'free' && dto.price !== 0) {
      throw new BadRequestException('Free content must be priced at ₦0.');
    }
    if (dto.accessType === 'paid' && dto.price <= 0) {
      throw new BadRequestException(
        'Paid content must have a price greater than ₦0.',
      );
    }

    const slug = `${this.slugify(dto.title)}-${randomUUID().slice(0, 8)}`;

    // The allowance is claimed inside one transaction. Counting outside it
    // would let two uploads sent at the same moment both read "2 used" and
    // both be written.
    const created = await this.prisma.$transaction(async (tx) => {
      // A REJECTED or REMOVED piece occupies no slot.
      //
      // POST /admin/content/:id/reject and DELETE /content/:id both give the
      // slot back by decrementing CreatorState.slotsUsed. `isFirstUpload`
      // derives from the count below, so without this filter a creator whose
      // only upload was rejected would get the slot back and still not count
      // as a first-time uploader.
      //
      // Two definitions of "used" that disagree are worse than either alone.
      const occupiesASlot = {
        status: {
          notIn: ['rejected', 'removed'] as ('rejected' | 'removed')[],
        },
      };
      const used = await tx.contentPiece.count({
        where: { creatorWawuId, ...occupiesASlot },
      });
      // Recorded, never enforced. R-8 removed the first-upload-must-be-free
      // rule: a first upload may be free or paid. The flag stays because the
      // creator dashboard labels "Your first upload" from it; the column
      // keeps its old name to avoid a migration.
      const isFirstUpload = used === 0;

      // The cap counts products, content AND services together, so it is held
      // on CreatorState.slotsUsed rather than on a count of ContentPiece rows.
      //
      // The row is created on demand: it used to exist only once a creator had
      // paid for a subscription, so requiring one here would be the payment
      // gate under another name.
      await tx.creatorState.upsert({
        where: { wawuUserId: creatorWawuId },
        create: { wawuUserId: creatorWawuId },
        update: {},
      });

      // Claimed conditionally, so the cap holds even against a concurrent
      // upload that read the same count.
      const claimed = await tx.creatorState.updateMany({
        where: {
          wawuUserId: creatorWawuId,
          slotsUsed: { lt: allowance.total },
        },
        data: { slotsUsed: { increment: 1 } },
      });
      if (claimed.count === 0) {
        // Only this NEW upload is refused. Pieces already published stay as
        // they are, even when the account is above the cap (a tick that
        // lapsed with more than 5 pieces live).
        throw new ForbiddenException({
          message: `You have used all ${allowance.total} of your upload slots. Remove an item to free one up.`,
          reason: {
            code: 'upload_limit_reached',
            uploadsAllowed: allowance.total,
            tickHeld,
            uploadsWithTick: TICK_UPLOADS,
          },
        });
      }

      return tx.contentPiece.create({
        data: {
          slug,
          creatorWawuId,
          contentType: dto.contentType as never,
          title: dto.title,
          description: dto.description,
          category: dto.category,
          specializations: dto.specializations ?? [],
          tags: dto.tags ?? [],
          accessType: dto.accessType as never,
          price: dto.price,
          previewAssetUrl: dto.previewAsset,
          fullAssetUrl: dto.fullAsset,
          creatorFirstUploadFree: isFirstUpload,
          status: 'pending',
        },
      });
    });

    return this.toResponse(created, true);
  }

  // ── My content (ME-09): library, edit, send again ──────────────────────────

  /**
   * Sales and the latest rejection for a batch of the creator's own pieces,
   * in two grouped reads. A rejection is reported only for a piece that is
   * `rejected` right now: after a resubmit the stored decision is history.
   */
  private async toMyContentItems(
    rows: ContentPieceRow[],
  ): Promise<MyContentItem[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const rejectedIds = rows
      .filter((r) => r.status === 'rejected')
      .map((r) => r.id);

    const [sales, rejections] = await Promise.all([
      this.prisma.purchase.groupBy({
        by: ['contentId'],
        where: { contentId: { in: ids }, type: 'content', status: 'completed' },
        _count: { _all: true },
      }),
      rejectedIds.length === 0
        ? Promise.resolve([])
        : this.prisma.adminContentReview.findMany({
            where: { contentId: { in: rejectedIds }, decision: 'rejected' },
            orderBy: { reviewedAt: 'desc' },
            select: { contentId: true, reason: true, reviewedAt: true },
          }),
    ]);

    const salesById = new Map<string, number>();
    for (const row of sales) {
      if (row.contentId) salesById.set(row.contentId, row._count._all);
    }
    // Newest first, so the first row seen per piece is the latest decision.
    const latest = new Map<
      string,
      { reason: string | null; reviewedAt: Date }
    >();
    for (const row of rejections) {
      if (!latest.has(row.contentId)) {
        latest.set(row.contentId, {
          reason: row.reason,
          reviewedAt: row.reviewedAt,
        });
      }
    }

    // The owner always has the full file (resolveUnlockedSet counts the creator).
    return Promise.all(
      rows.map(async (row) => {
        const rejection = latest.get(row.id);
        return {
          ...(await this.toResponse(row, true)),
          salesCount: salesById.get(row.id) ?? 0,
          rejectionReason: rejection?.reason ?? null,
          rejectedAt: rejection?.reviewedAt ?? null,
        };
      }),
    );
  }

  /** GET /content/mine/library: the creator's pieces, newest first, with sales and the reason. */
  async listMyLibrary(
    creatorWawuId: string,
    status: MyContentFilter | undefined,
    page: number,
    perPage: number,
  ): Promise<Paginated<MyContentItem>> {
    const where = {
      creatorWawuId,
      status: status ? status : { not: 'removed' as const },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contentPiece.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.contentPiece.count({ where }),
    ]);
    return {
      items: await this.toMyContentItems(rows),
      currentPage: page,
      perPage,
      total,
    };
  }

  /** GET /content/mine/library/counts: the numbers on the filter tabs. */
  async myLibraryCounts(creatorWawuId: string): Promise<MyContentCounts> {
    const grouped = await this.prisma.contentPiece.groupBy({
      by: ['status'],
      where: { creatorWawuId, status: { in: ['live', 'pending', 'rejected'] } },
      _count: { _all: true },
    });
    const count = (s: string) =>
      grouped.find((g) => g.status === s)?._count._all ?? 0;
    const live = count('live');
    const pending = count('pending');
    const rejected = count('rejected');
    return { all: live + pending + rejected, live, pending, rejected };
  }

  /** GET /content/mine/library/:id: one of the creator's own pieces (M26). */
  async getMyPiece(id: string, creatorWawuId: string): Promise<MyContentItem> {
    const row = await this.ownPieceOrThrow(id, creatorWawuId);
    return (await this.toMyContentItems([row]))[0];
  }

  private async ownPieceOrThrow(
    id: string,
    creatorWawuId: string,
  ): Promise<ContentPieceRow> {
    const row = await this.prisma.contentPiece.findUnique({ where: { id } });
    if (!row || row.status === 'removed') {
      throw new NotFoundException('Content not found');
    }
    if (row.creatorWawuId !== creatorWawuId) {
      throw new ForbiddenException('You can only change your own content.');
    }
    return row;
  }

  /**
   * PATCH /content/:id: edit details or replace the file while the piece is
   * `pending` (waiting for review) or `rejected` (to fix what the reviewer
   * named). A live piece is not editable: the review approved those files and
   * that text, and an edit would skip the review.
   *
   * Editing never changes `status`: a rejected piece stays rejected until the
   * creator sends it again (`resubmit`), so a half-finished fix is never
   * queued. The same price rules as `create` apply to the result of the edit,
   * not only to the fields sent.
   */
  async updateMine(
    id: string,
    creatorWawuId: string,
    dto: UpdateContentDto,
  ): Promise<MyContentItem> {
    const existing = await this.ownPieceOrThrow(id, creatorWawuId);
    if (existing.status === 'live') {
      throw new ConflictException(
        'A live piece cannot be edited. Take it down to change it.',
      );
    }

    const changes: Prisma.ContentPieceUpdateManyMutationInput = {};
    if (dto.title !== undefined) changes.title = dto.title;
    if (dto.description !== undefined) changes.description = dto.description;
    if (dto.category !== undefined) changes.category = dto.category;
    if (dto.specializations !== undefined)
      changes.specializations = dto.specializations;
    if (dto.tags !== undefined) changes.tags = dto.tags;
    if (dto.accessType !== undefined) changes.accessType = dto.accessType;
    if (dto.previewAsset !== undefined)
      changes.previewAssetUrl = dto.previewAsset;
    if (dto.fullAsset !== undefined) changes.fullAssetUrl = dto.fullAsset;

    const accessType = dto.accessType ?? existing.accessType;
    // Switching to free needs no price from the creator: free is ₦0.
    const price = dto.price ?? (dto.accessType === 'free' ? 0 : existing.price);
    changes.price = price;

    if (Object.keys(changes).length === 1 && dto.price === undefined) {
      throw new BadRequestException('Send at least one field to change.');
    }
    if (accessType === 'free' && price !== 0) {
      throw new BadRequestException('Free content must be priced at ₦0.');
    }
    if (accessType === 'paid' && price <= 0) {
      throw new BadRequestException(
        'Paid content must have a price greater than ₦0.',
      );
    }
    const previewAsset = dto.previewAsset ?? existing.previewAssetUrl;
    const fullAsset = dto.fullAsset ?? existing.fullAssetUrl;
    if (accessType === 'paid' && previewAsset === fullAsset) {
      throw new BadRequestException(
        'Paid content needs a separate free preview. previewAsset must not be the same file as fullAsset.',
      );
    }

    // Conditional on the status read above: a reviewer approving the piece
    // at this instant must win, and the edit must not land on a live piece.
    const written = await this.prisma.contentPiece.updateMany({
      where: { id, creatorWawuId, status: { in: ['pending', 'rejected'] } },
      data: changes,
    });
    if (written.count === 0) {
      throw new ConflictException(
        'This piece was reviewed a moment ago. Open it again to see where it stands.',
      );
    }
    return this.getMyPiece(id, creatorWawuId);
  }

  /**
   * POST /content/:id/resubmit: send a rejected piece for review again.
   *
   * A rejection handed the slot back (admin reject), so sending it again
   * claims one, conditionally and in the same transaction as the status flip,
   * against the same allowance as an upload. At the cap it is refused with
   * the same `upload_limit_reached` reason as POST /content. Pressing it
   * twice is safe: a piece already `pending` is returned unchanged and no
   * second slot is claimed.
   */
  async resubmit(id: string, creatorWawuId: string): Promise<MyContentItem> {
    const existing = await this.ownPieceOrThrow(id, creatorWawuId);
    if (existing.status === 'pending') {
      return this.getMyPiece(id, creatorWawuId);
    }
    if (existing.status !== 'rejected') {
      throw new ConflictException('Only a rejected piece can be sent again.');
    }

    const tickHeld = holdsTick(
      await this.prisma.userProfile.findUnique({
        where: { wawuUserId: creatorWawuId },
        select: TICK_COLUMNS,
      }),
    );
    const allowance = uploadAllowanceFor(tickHeld);

    await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.contentPiece.updateMany({
        where: { id, creatorWawuId, status: 'rejected' },
        data: { status: 'pending' },
      });
      // Lost a race with a second tap: the winner already claimed the slot.
      if (flipped.count === 0) return;

      await tx.creatorState.upsert({
        where: { wawuUserId: creatorWawuId },
        create: { wawuUserId: creatorWawuId },
        update: {},
      });
      const claimed = await tx.creatorState.updateMany({
        where: {
          wawuUserId: creatorWawuId,
          slotsUsed: { lt: allowance.total },
        },
        data: { slotsUsed: { increment: 1 } },
      });
      if (claimed.count === 0) {
        // Throwing rolls the status flip back with it.
        throw new ForbiddenException({
          message: `You have used all ${allowance.total} of your upload slots. Remove an item to free one up.`,
          reason: {
            code: 'upload_limit_reached',
            uploadsAllowed: allowance.total,
            tickHeld,
            uploadsWithTick: TICK_UPLOADS,
          },
        });
      }
    });
    return this.getMyPiece(id, creatorWawuId);
  }

  async listPurchases(
    buyerWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<Record<string, unknown>>> {
    const where = { buyerWawuId, type: 'content' as const };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where,
        orderBy: { purchasedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return {
      items: items.map((p) => ({
        ...p,
        commissionRate: p.commissionRate.toNumber(),
      })),
      currentPage: page,
      perPage,
      total,
    };
  }

  async unlock(
    contentId: string,
    buyerWawuId: string,
  ): Promise<FlutterwaveConfigResponse> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (!content || content.status !== 'live') {
      throw new NotFoundException('Content not found');
    }
    if (content.accessType === 'free') {
      throw new BadRequestException(
        'This content is free — no unlock required.',
      );
    }
    if (content.creatorWawuId === buyerWawuId) {
      throw new BadRequestException('Cannot purchase your own content.');
    }

    const alreadyUnlocked = await this.prisma.purchase.findFirst({
      where: { contentId, buyerWawuId, type: 'content', status: 'completed' },
      select: { id: true },
    });
    if (alreadyUnlocked) {
      throw new BadRequestException('You have already unlocked this content.');
    }

    const commissionRate = this.resolveCommissionRate();
    const charge = this.flutterwave.initCharge({
      amount: content.price,
      purpose: 'content-unlock',
      wawuUserId: buyerWawuId,
    });

    await this.prisma.purchase.create({
      data: {
        contentId,
        type: 'content',
        buyerWawuId,
        creatorWawuId: content.creatorWawuId,
        amount: content.price,
        commissionRate,
        flutterwaveTxRef: charge.txRef,
        flutterwaveTxId: null,
        status: 'pending',
        note: null,
      },
    });

    return {
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
    };
  }

  async verifyUnlock(
    contentId: string,
    buyerWawuId: string,
    dto: VerifyUnlockDto,
  ): Promise<UnlockVerifyResult> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }

    const purchase = await this.prisma.purchase.findFirst({
      where: {
        flutterwaveTxRef: dto.tx_ref,
        buyerWawuId,
        contentId,
        type: 'content',
      },
    });
    if (!purchase) {
      throw new NotFoundException(
        'No matching unlock attempt found for this reference',
      );
    }

    if (purchase.status === 'completed') {
      return {
        purchased: true,
        fullAssetUrl: await this.storage.freshUrlFor(content.fullAssetUrl),
      };
    }
    if (purchase.status === 'failed') {
      throw new BadRequestException(
        'This unlock attempt already failed verification',
      );
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const verified =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === purchase.flutterwaveTxRef &&
      result.amount >= purchase.amount;

    if (!verified) {
      await this.prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: 'failed', flutterwaveTxId: result.transactionId },
      });
      throw new BadRequestException('Payment verification failed');
    }

    // Conditional flip: two concurrent verifies both read 'pending' above,
    // so an unconditional update would let both proceed. Unlocking is
    // idempotent so a lost race is harmless here, but the same shape guards
    // the paid-credit path in credit-purchase where it is not.
    const settled = await this.prisma.purchase.updateMany({
      where: { id: purchase.id, status: 'pending' },
      data: { status: 'completed', flutterwaveTxId: result.transactionId },
    });

    // "You sold something" — to the CREATOR, after settlement, and only for
    // the caller that won the pending->completed flip so the browser
    // /verify and the Flutterwave webhook cannot both announce the same
    // sale. A failed verification threw above and never gets here.
    if (settled.count > 0) {
      await this.notifications.emit({
        kind: 'sale',
        userWawuId: purchase.creatorWawuId,
        contentTitle: content.title,
        netAmount: netOfCommission(purchase.amount, purchase.commissionRate),
      });
    }

    return {
      purchased: true,
      fullAssetUrl: await this.storage.freshUrlFor(content.fullAssetUrl),
    };
  }

  async save(contentId: string, userWawuId: string): Promise<SavedItem> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: { id: true },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }

    return this.prisma.savedItem.upsert({
      where: { userWawuId_contentId: { userWawuId, contentId } },
      update: {},
      create: { userWawuId, contentId },
    });
  }

  async unsave(contentId: string, userWawuId: string): Promise<void> {
    await this.prisma.savedItem.deleteMany({
      where: { userWawuId, contentId },
    });
  }

  /**
   * Recomputes `ratingPct` (registry note: "designed-state task ... New
   * endpoint recomputes the aggregate"). The frozen schema stores only a
   * single mutable `ratingPct` scalar with no per-rating history/count
   * column (confirmed: no Rating model, no ratingCount field) — a true
   * running average across N raters is not representable without a schema
   * change, which is out of scope (schema is frozen per task brief). This
   * is therefore an honest, documented two-point blend (previous aggregate
   * folded 50/50 with the new submission's own percentage), not a
   * fabricated N-weighted average.
   */
  async rate(
    contentId: string,
    raterWawuId: string,
    dto: RateContentDto,
  ): Promise<ContentPieceResponse> {
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }

    const submittedPct = dto.rating * 20;
    const newRatingPct =
      content.ratingPct === null
        ? submittedPct
        : Math.round((content.ratingPct + submittedPct) / 2);

    const updated = await this.prisma.contentPiece.update({
      where: { id: contentId },
      data: { ratingPct: newRatingPct },
    });

    const unlockedSet = await this.resolveUnlockedSet(raterWawuId, [
      updated.id,
    ]);
    return this.toResponse(updated, unlockedSet.has(updated.id));
  }
}
