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
import { PublishingGate } from '../plans/publishing-gate.service';
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
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import {
  COVER_FOLDER,
  StorageService,
  objectKeyFrom,
} from '../storage/storage.service';
import { isAppRequest } from '../price-list/app-client';
import { COVER_NOT_USABLE, coverKeyOf } from './content-cover';
import {
  LOCKED_TX,
  inPersonsTurn,
  lockStorageQuota,
} from '../storage/storage-lock';
import type { VerifyUnlockDto } from './dto/verify-unlock.dto';
import type { UpdateContentDto } from './dto/update-content.dto';
import type { MyContentFilter } from './dto/my-content-query.dto';
import type { MyContentCounts, MyContentItem } from './dto/my-content.view';
import {
  assertBuyerOnlyIfHidden,
  hasBoughtContent,
  readHidden,
} from './deletion-hid';

/**
 * The commission rate, for every creator (conventions.md § Identity & format
 * canon). The 10% Pro rate went with the subscription that sold it; there is
 * no tier left to vary on.
 */
const STANDARD_COMMISSION_RATE = 0.15;

/**
 * How many times `delete` reads a piece again when its status moved between
 * the read and the write. Two moves in a row (rejected, sent again, rejected
 * again) inside one request's few milliseconds is not a case worth more.
 */
const DELETE_ATTEMPTS = 3;

/**
 * Said when a listing names a file its owner released or whose upload never
 * arrived (ME-04 round 4): the space of such a file is not counted, so a
 * listing on it would hold storage that nothing counts. Photo-set frames are
 * refused the same way (content-media.service.ts).
 */
const GIVEN_UP_FILE =
  'One of these files was released or never arrived. Upload it again.';

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
  /** CONTENT-COVER: the cover's storage key; never served as it is (`coverUrl` is the signed link). */
  coverKey?: string | null;
  creatorFirstUploadFree: boolean;
  status: string;
  views: number;
  ratingPct: number | null;
  commentCount: number;
  likes: number;
  createdAt: Date;
}

/** Thrown inside a transaction when the conditional claim of a place found none free. */
class PlaceNotClaimed extends Error {
  constructor() {
    super('No place was free to claim.');
  }
}

// Imported here, after the exported types, so they stay where they were.
import { Optional, ServiceUnavailableException } from '@nestjs/common';
import { PriceListService } from '../price-list/price-list.service';
import { PreviewCutService } from './preview-cut.service';

/**
 * Said when a listing names a file another person uploaded (SWEEP-APP-5, row
 * ME-04 R2-4): a key of ours is a claim on a file, and only its uploader may
 * make it. A link elsewhere matches no row and still passes, as before.
 */
const NOT_YOUR_FILE = 'One of these files is not yours. Upload your own.';

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
    private readonly blockedAccounts: BlockedAccountService,
    private readonly gate: PublishingGate,
    private readonly priceList: PriceListService,
    // UPLOAD-REST: makes the preview of a free piece that an edit turns to paid. Optional so a spec that builds this service by
    // hand keeps working; without it the flag is ignored and the edit reads as it always did.
    @Optional() private readonly previews?: PreviewCutService,
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
    // CONTENT-COVER (R-114): `coverUrl` is served on the app's requests (`X-Wawu-Client: app`) and on the routes only the
    // app calls (`cover: true`: the feed, My content). The routes the web and the dashboard call keep every byte of their
    // answer, so on a request without the header the field is absent, as is `coverKey` on every answer.
    opts: { cover?: boolean } = {},
  ): Promise<ContentPieceResponse> {
    const { coverKey, ...row } = content;
    const isFree = row.accessType === 'free';
    const locked = !isFree && !unlocked;
    const withCover = opts.cover ?? isAppRequest();
    const [previewAssetUrl, fullAssetUrl, coverUrl] = await Promise.all([
      this.storage.freshUrlFor(row.previewAssetUrl),
      locked ? null : this.storage.freshUrlFor(row.fullAssetUrl),
      withCover ? this.storage.coverUrlFor(coverKey) : null,
    ]);
    return {
      ...row,
      previewAssetUrl: previewAssetUrl as string,
      fullAssetUrl,
      fullAssetLocked: locked,
      ...(withCover ? { coverUrl } : {}),
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
    const first = await this.prisma.contentPiece.findUnique({
      where: { id },
    });
    if (!first) {
      throw new NotFoundException('Content not found');
    }
    // Removed is gone for everyone, owner included — there is no undelete,
    // so an owner-exception here would resurrect a piece nothing else can see.
    // One kind of removed piece is still read by the people who paid for it:
    // a sold piece its creator's account deletion hid (owner ruling, 16 Oct
    // 2026, SETTINGS-06; from the moment of DELETE, lead ruling 17 Oct 2026).
    // Only a completed purchase opens it, never ownership: the creator who
    // asked for the deletion is not let back in.
    // `content` is the piece as it is when that is decided: a purge or a cancel
    // that lands between the read and the check is not a 404 (round 9).
    const { piece: content, hidden: keptForBuyers } = await readHidden(
      this.prisma,
      first,
    );
    if (!content || (content.status === 'removed' && !keptForBuyers)) {
      throw new NotFoundException('Content not found');
    }
    if (
      !keptForBuyers &&
      content.status !== 'live' &&
      content.creatorWawuId !== requesterWawuId
    ) {
      throw new NotFoundException('Content not found');
    }
    if (
      keptForBuyers &&
      !(await hasBoughtContent(this.prisma, content.id, requesterWawuId))
    ) {
      throw new NotFoundException('Content not found');
    }

    const unlockedSet = await this.resolveUnlockedSet(requesterWawuId, [
      content.id,
    ]);
    // SETTINGS-04: a piece by someone the caller blocked (or who blocked the
    // caller) is gone, with the same 404 as a piece that never existed. One
    // exception: somebody who already paid for it keeps their copy, because a
    // block must never take away what a person bought.
    if (!unlockedSet.has(content.id)) {
      await this.blockedAccounts.assertVisible(
        requesterWawuId,
        content.creatorWawuId,
        'Content not found',
      );
    }
    return this.toResponse(content, unlockedSet.has(content.id));
  }

  async list(
    requesterWawuId: string | undefined,
    scope: 'feed' | 'mine' | 'following' | undefined,
    category: string | undefined,
    page: number,
    perPage: number,
    sort: ContentSort = 'trending',
    cover?: boolean,
  ): Promise<Paginated<ContentPieceResponse>> {
    // SETTINGS-04: the feed leaves out anyone the caller blocked or who
    // blocked the caller. The caller's own shelf ('mine') is theirs alone.
    const hidden =
      scope === 'mine'
        ? []
        : await this.blockedAccounts.hiddenFrom(requesterWawuId);
    // REPORT-UGC: a piece the caller reported never comes back to them (them only).
    const reported =
      scope === 'mine'
        ? []
        : await this.blockedAccounts.reportedIds(requesterWawuId, 'piece');

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
            creatorWawuId: { in: followedIds, notIn: hidden },
            id: { notIn: reported },
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
          : {
              status: 'live' as const,
              creatorWawuId: { notIn: hidden },
              id: { notIn: reported },
              ...(category ? { category } : {}),
            };

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
        [items, total] = await this.listRanked(
          category,
          sort,
          page,
          perPage,
          hidden,
          reported,
        );
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
        items.map((item) =>
          this.toResponse(item, unlockedSet.has(item.id), { cover }),
        ),
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
    hidden: string[],
    reported: string[] = [],
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
        AND NOT (c."creatorWawuId" = ANY(${hidden}::text[]))
        AND NOT (c."id" = ANY(${reported}::text[]))
      ORDER BY ${score} DESC, c."createdAt" DESC
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `);

    const total = await this.prisma.contentPiece.count({
      where: {
        status: 'live',
        creatorWawuId: { notIn: hidden },
        id: { notIn: reported },
        ...(category ? { category } : {}),
      },
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
    // SETTINGS-04: a hidden creator's shelf is a 404, like their profile.
    await this.blockedAccounts.assertVisible(
      requesterWawuId,
      creatorWawuId,
      'User not found',
    );
    // A missing id answers exactly as a hidden creator does, so a signed-in
    // caller cannot use the shelf to tell a blocked account from one that
    // does not exist. A signed-out reader cannot be blocked, so the public
    // shelf keeps its old answer (an empty list) for an unknown id.
    if (requesterWawuId) {
      const exists = await this.prisma.userProfile.findUnique({
        where: { wawuUserId: creatorWawuId },
        select: { wawuUserId: true },
      });
      if (!exists) throw new NotFoundException('User not found');
    }
    // REPORT-UGC: a piece the caller reported is left out of the creator's shelf for them only.
    // A signed-out reader has reported nothing. Opening the piece by its own link still works.
    const reported = await this.blockedAccounts.reportedIds(
      requesterWawuId,
      'piece',
    );
    const where = {
      creatorWawuId,
      status: 'live' as const,
      id: { notIn: reported },
    };

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
   *
   * One piece gives its place back once, however many requests remove it
   * (TIER-02 round 2, D1: six `DELETE`s sent together used to free six).
   * The flip is conditional on the status this request read INSIDE the
   * transaction, so of any number of requests only the one whose write
   * changed the row decrements, and it decrements for the status it really
   * changed from. A request that loses answers as a repeat delete does, 404.
   * If the status moved between the read and the write (an admin rejected the
   * piece, or the creator sent it again) the read is taken again.
   */
  async delete(id: string, requesterWawuId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
        const existing = await tx.contentPiece.findUnique({
          where: { id },
          select: { status: true, creatorWawuId: true },
        });
        if (!existing || existing.status === 'removed') {
          throw new NotFoundException('Content not found');
        }
        if (existing.creatorWawuId !== requesterWawuId) {
          throw new ForbiddenException('You can only delete your own content.');
        }

        // Only a row still in the status just read is changed. That status
        // is not `removed` (checked above), so a piece another request has
        // already removed never matches and frees nothing.
        const flipped = await tx.contentPiece.updateMany({
          where: {
            id,
            creatorWawuId: requesterWawuId,
            status: existing.status,
          },
          data: { status: 'removed' },
        });
        if (flipped.count === 0) continue;

        if (existing.status !== 'rejected') {
          await tx.creatorState.updateMany({
            where: { wawuUserId: requesterWawuId, slotsUsed: { gt: 0 } },
            data: { slotsUsed: { decrement: 1 } },
          });
        }
        return;
      }
      throw new ConflictException(
        'This piece changed while you removed it. Try again.',
      );
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

  /**
   * The person's place counter, made if it is not there yet, so the claim
   * that follows always finds a row. Insert-or-nothing and not an upsert:
   * an upsert reads first and then inserts, so two first publishes sent
   * together both missed the row and the loser answered 409 "That record
   * already exists." to a publish that was fine (TIER-02 round 2, D2). Here
   * the second request waits for the first to commit and does nothing.
   */
  private async ensureCreatorState(
    tx: Prisma.TransactionClient,
    wawuUserId: string,
  ): Promise<void> {
    await tx.creatorState.createMany({
      data: [{ wawuUserId }],
      skipDuplicates: true,
    });
  }

  /**
   * An honest upload slower than the 15 minutes the Hub waits (any usage read
   * in the middle abandons its pending row) that then lands used to be refused
   * here, although the file was in the bucket (SWEEP-APP-5, row ME-04 R4-5).
   * Before the check, each key the listing names whose row is the person's own,
   * `abandoned` and never released is settled the way `POST /uploads/confirm`
   * settles it: the bucket is asked, and a file that is there and fits comes
   * back as `confirmed`. It runs outside any transaction or lock, because the
   * bucket is a network call: the routes that publish call it just before
   * `create` (POST /content and a draft's publish), and an edit calls it itself. A file that does not fit is refused with the
   * storage 413, as a confirm refuses it; a bucket that cannot be asked leaves
   * the row as it is, and the check below answers as it always did.
   */
  async settleSlowUploads(
    creatorWawuId: string,
    dto: {
      previewAsset?: string | null;
      fullAsset?: string | null;
      coverAsset?: string | null;
    },
  ): Promise<void> {
    const keys = [
      ...new Set(
        [dto.previewAsset, dto.fullAsset, dto.coverAsset]
          .filter((u): u is string => typeof u === 'string' && u !== '')
          .map((u) => objectKeyFrom(u))
          // eslint-disable-next-line no-control-regex -- a control character is in no key we wrote
          .filter((k) => !/[\u0000-\u001f\u007f]/.test(k)),
      ),
    ];
    if (keys.length === 0) return;
    const late = await this.prisma.storageObject.findMany({
      where: {
        key: { in: keys },
        wawuUserId: creatorWawuId,
        status: 'abandoned',
        releasedAt: null,
        removingAt: null,
      },
      select: { key: true },
    });
    for (const row of late) {
      try {
        await this.storage.settleUpload(creatorWawuId, row.key);
      } catch (err) {
        if (err instanceof ServiceUnavailableException) continue;
        throw err;
      }
    }
  }

  /**
   * Refuses a listing that names a file its owner released, or whose upload
   * never arrived (the row is `abandoned`): 400, as a photo-set frame is
   * refused. The files of such a row are not counted against the person's
   * storage, so a listing on one would keep them uncounted for good (ME-04
   * round 4). Runs inside the caller's transaction, under the person's storage
   * lock, so a release or the sweep that is deciding about the same key
   * finishes first: a key released a moment ago is seen here as released, and
   * a key named here is seen by the release (409) and by the sweep as claimed.
   * A key whose row belongs to someone else is refused too (400, SWEEP-APP-5,
   * ME-04 R2-4): the check is the row's owner, as a photo-set frame's is, so a
   * piece cannot be built on another person's file. A value that is not one of
   * our keys (a link elsewhere) matches no row and passes, as before.
   */
  private async assertFilesNotGivenUp(
    tx: Prisma.TransactionClient,
    creatorWawuId: string,
    urls: readonly (string | null | undefined)[],
  ): Promise<void> {
    const keys = [
      ...new Set(
        urls
          .filter((u): u is string => typeof u === 'string' && u !== '')
          .map((u) => objectKeyFrom(u))
          // eslint-disable-next-line no-control-regex -- a control character is in no key we wrote
          .filter((k) => !/[\u0000-\u001f\u007f]/.test(k)),
      ),
    ];
    if (keys.length === 0) return;
    await lockStorageQuota(tx, creatorWawuId);
    const rows = await tx.storageObject.findMany({
      where: { key: { in: keys } },
      select: { wawuUserId: true, status: true, removingAt: true },
    });
    if (rows.some((row) => row.wawuUserId !== creatorWawuId)) {
      throw new BadRequestException(NOT_YOUR_FILE);
    }
    // A file being removed is released and abandoned already; the mark is
    // named too so the rule reads as it is (ME-04 round 5).
    if (rows.some((row) => row.status === 'abandoned' || row.removingAt)) {
      throw new BadRequestException(GIVEN_UP_FILE);
    }
  }

  /**
   * The check every way of publishing a piece makes inside its create
   * transaction (see `assertFilesNotGivenUp`): pass it as `create`'s
   * `inTransaction`, or call it from yours.
   */
  filesUsableIn(
    creatorWawuId: string,
    dto: Pick<CreateContentDto, 'previewAsset' | 'fullAsset' | 'coverAsset'>,
  ): (tx: Prisma.TransactionClient) => Promise<void> {
    return async (tx) => {
      await this.assertFilesNotGivenUp(tx, creatorWawuId, [
        dto.previewAsset,
        dto.fullAsset,
        dto.coverAsset,
      ]);
      await this.assertCoverUsable(tx, creatorWawuId, dto.coverAsset);
    };
  }

  /**
   * CONTENT-COVER (R-114): a cover named by a listing must be an upload of THIS person in the cover folder (the key's
   * own prefix says whose it is, and the row proves the upload was made). Whether it was released or never arrived is
   * `assertFilesNotGivenUp`'s, which the same callers run first. Runs inside the caller's transaction.
   */
  private async assertCoverUsable(
    tx: Prisma.TransactionClient,
    creatorWawuId: string,
    cover: string | null | undefined,
  ): Promise<void> {
    const key = coverKeyOf(creatorWawuId, cover);
    if (!key) return;
    const row = await tx.storageObject.findUnique({
      where: { key },
      select: { wawuUserId: true, folder: true },
    });
    if (!row || row.wawuUserId !== creatorWawuId || row.folder !== COVER_FOLDER)
      throw new BadRequestException(COVER_NOT_USABLE);
  }

  /**
   * Gives the space of a cover that a listing no longer names back, and deletes its file. Called after the edit has
   * committed, holding nothing: a bucket that cannot be reached leaves the file counted and the person's, and it goes
   * with their account (an edit that succeeded is never undone for it).
   */
  private async releaseOldCover(
    creatorWawuId: string,
    key: string | null | undefined,
    keptKey: string | null | undefined,
  ): Promise<void> {
    if (!key || key === keptKey) return;
    try {
      await this.storage.releaseUpload(creatorWawuId, key);
    } catch (err) {
      this.logger.warn(`Could not remove the old cover ${key}: ${String(err)}`);
    }
  }

  /**
   * Runs a transaction that claims a place (create, resubmit) and, when the
   * claim loses, answers with the gate's refusal. The transaction only throws
   * `PlaceNotClaimed` (which rolls it back, so a draft it deleted comes back);
   * the refusal is read here, after the transaction has ended and released its
   * connection. Reading it inside, through the Hub's client, took a second
   * pooled connection while the first held the person's lock, and a burst of
   * one person's requests could then use up the whole pool (ME-04 round 6).
   */
  private async refusedWhenPlaceNotClaimed<T>(
    creatorWawuId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof PlaceNotClaimed) {
        throw await this.gate.limitReachedFor(creatorWawuId);
      }
      throw err;
    }
  }

  /**
   * FIX-111 (H24): a piece may say it comes from a course only when that course is the creator's own, is live or in review,
   * and the piece is not a course itself. One refusal for every other case, so a stranger's course id says nothing about it.
   */
  private async assertOwnCourse(
    creatorWawuId: string,
    dto: Pick<CreateContentDto, 'contentType' | 'parentCourseId'>,
  ): Promise<void> {
    if (dto.contentType === 'course') {
      throw new BadRequestException(
        'A course cannot come from another course.',
      );
    }
    const parent = await this.prisma.contentPiece.findUnique({
      where: { id: dto.parentCourseId },
      select: { creatorWawuId: true, contentType: true, status: true },
    });
    if (
      !parent ||
      parent.creatorWawuId !== creatorWawuId ||
      parent.contentType !== 'course' ||
      (parent.status !== 'live' && parent.status !== 'pending')
    ) {
      throw new BadRequestException(
        'Choose one of your own courses that is live or in review.',
      );
    }
  }

  /**
   * `inTransaction`, when given, runs inside the publish transaction before
   * the place is claimed: a draft being published deletes itself there, so a
   * second tap finds it gone and publishes nothing twice.
   */
  async create(
    creatorWawuId: string,
    dto: CreateContentDto,
    inTransaction?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<ContentPieceResponse> {
    // Publishing needs a tier (R-43, TIER-02), or a verification tick that has
    // not ended, and a free place for one more product. CreatorAccountGuard on
    // POST /content has already proved this caller is a creator account.
    // The gate refuses with 402 `tier_required` or `product_limit_reached`;
    // the route's interceptor adds the offers. A free piece is allowed as the
    // first upload or any other, and takes a place exactly like a paid one
    // (R-8).
    const allowance = await this.gate.assertRoomForProduct(creatorWawuId);
    // PREVIEW-AUTO: the routes that publish resolve the preview (a cut file, or the full file of a free piece) before they call
    // `create`, so it is set by here; a caller that did not is refused rather than stored with no preview.
    const previewAsset = dto.previewAsset;
    if (!previewAsset)
      throw new BadRequestException(
        'Paid content needs a preview. Add a clip, or ask us to make it from your file.',
      );

    // `previewAsset` is public by design — it is returned to every caller,
    // including anonymous ones on /content/public/featured. If it points at
    // the same object as `fullAsset`, the paywall is decorative: anyone can
    // read the preview URL and download the paid asset. Reject it rather
    // than silently shipping unlocked content.
    if (dto.accessType === 'paid' && dto.previewAsset === dto.fullAsset) {
      throw new BadRequestException(
        'Paid content needs a separate free preview: previewAsset must not be the same file as fullAsset.',
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
    // PRICE-LIST round 2: this is also the website's route (and the draft
    // publish's), so the list applies only to the app's requests
    // (`X-Wawu-Client: app`); without the header nothing here changes.
    if (dto.accessType === 'paid') {
      this.priceList.forThisRequest().assertOnList(dto.price);
    }

    if (dto.parentCourseId !== undefined) {
      await this.assertOwnCourse(creatorWawuId, dto);
    }

    // CONTENT-COVER: the cover, if any, must be this person's own upload (400 otherwise); the row is checked in the transaction.
    const coverKey = coverKeyOf(creatorWawuId, dto.coverAsset) ?? null;

    const slug = `${this.slugify(dto.title)}-${randomUUID().slice(0, 8)}`;

    // The allowance is claimed inside one transaction. Counting outside it
    // would let two uploads sent at the same moment both read "2 used" and
    // both be written.
    //
    // The transaction takes the person's storage lock, so it starts in the
    // person's turn (storage-lock.ts `inPersonsTurn`): a burst of requests
    // waits in memory, not on pooled connections (ME-04 round 6).
    const created = await this.refusedWhenPlaceNotClaimed(creatorWawuId, () =>
      inPersonsTurn(creatorWawuId, () =>
        this.prisma.$transaction(async (tx) => {
          if (inTransaction) await inTransaction(tx);
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
          await this.ensureCreatorState(tx, creatorWawuId);

          // Claimed conditionally, so the cap holds even against a concurrent
          // upload that read the same count.
          const claimed = await tx.creatorState.updateMany({
            where: {
              wawuUserId: creatorWawuId,
              slotsUsed: { lt: allowance.productsAllowed },
            },
            data: { slotsUsed: { increment: 1 } },
          });
          if (claimed.count === 0) {
            // Only this NEW upload is refused. Pieces already published stay as
            // they are, even when the account is above its allowance (a tier or
            // a tick that ended with more pieces live). Throwing rolls the
            // transaction back, so a draft deleted above comes back with it. The
            // refusal itself is built after the transaction has ended
            // (`refusedWhenPlaceNotClaimed`): reading the allowance here would
            // take a second pooled connection while this one holds the person's
            // lock, which is how a burst once froze the whole pool (ME-04 round
            // 6).
            throw new PlaceNotClaimed();
          }

          const row = await tx.contentPiece.create({
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
              previewAssetUrl: previewAsset,
              fullAssetUrl: dto.fullAsset,
              coverKey,
              creatorFirstUploadFree: isFirstUpload,
              status: 'pending',
            },
          });
          // FIX-111: the course this piece comes from lives on its side row (a column on the piece would widen every response).
          if (dto.parentCourseId) {
            await tx.contentDetail.create({
              data: { contentId: row.id, parentCourseId: dto.parentCourseId },
            });
          }
          return row;
          // May wait for the person's storage lock while a release or the sweep
          // finishes a call to the bucket: longer than Prisma's 5 s default.
        }, LOCKED_TX),
      ),
    );

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
        const piece = await this.toResponse(row, true, { cover: true });
        return {
          ...piece,
          coverUrl: piece.coverUrl ?? null,
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
    contentType?: 'course',
  ): Promise<Paginated<MyContentItem>> {
    const where = {
      creatorWawuId,
      status: status ? status : { not: 'removed' as const },
      ...(contentType ? { contentType } : {}),
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
    // An edit that carries a file is accepting a file (TIER-02): it needs a
    // way to publish. It does not ask for room: the piece has its place
    // already, or gets one when it is sent again (`resubmit`).
    // CONTENT-COVER: `coverAsset` is the key of the cover, or null to take it off; left out, the cover stays.
    const coverKey = coverKeyOf(creatorWawuId, dto.coverAsset);
    // UPLOAD-REST (R-118): a free piece edited to paid has no preview of its own (its preview is its file). With the flag, the Hub
    // makes one from the stored file, so nobody uploads a separate clip. That stores a file, so it needs a way to publish too.
    const fullAsset = dto.fullAsset ?? existing.fullAssetUrl;
    const wantsMade =
      dto.previewFromFile === true &&
      this.previews !== undefined &&
      fullAsset !== null &&
      (dto.accessType ?? existing.accessType) === 'paid' &&
      dto.previewAsset === undefined &&
      objectKeyFrom(existing.previewAssetUrl) === objectKeyFrom(fullAsset);
    if (
      dto.previewAsset !== undefined ||
      dto.fullAsset !== undefined ||
      wantsMade ||
      (coverKey !== undefined && coverKey !== null)
    )
      await this.gate.assertMayUpload(creatorWawuId);

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
    if (coverKey !== undefined) changes.coverKey = coverKey;

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
    // PRICE-LIST (R-101): a price a creator sets is on the price list. Only a
    // price that is being set is judged: an edit that leaves the price as it
    // is does not refuse a piece that already had one.
    if (
      accessType === 'paid' &&
      dto.price !== undefined &&
      dto.price !== existing.price
    ) {
      this.priceList.assertOnList(price);
    }
    // A paid piece whose preview is its own file is refused as it always was, unless the Hub is asked to make the preview.
    if (
      !wantsMade &&
      accessType === 'paid' &&
      (dto.previewAsset ?? existing.previewAssetUrl) === fullAsset
    ) {
      throw new BadRequestException(
        'Paid content needs a separate free preview. previewAsset must not be the same file as fullAsset.',
      );
    }

    await this.settleSlowUploads(creatorWawuId, {
      previewAsset: dto.previewAsset,
      fullAsset: dto.fullAsset,
      coverAsset: dto.coverAsset,
    });

    // UPLOAD-REST: the preview made from the stored file, after every other check has passed so a refused edit stores nothing.
    // The cut is a file of the creator's, counted once (the same name for the same full file, so a retry replaces it in place);
    // it is given back below when the edit does not go through.
    let made: { previewAsset: string; made: string | null } | null = null;
    if (wantsMade && this.previews && fullAsset) {
      made = await this.previews.resolve(creatorWawuId, {
        contentType: existing.contentType,
        accessType: 'paid',
        fullAsset,
        previewFromFile: true,
        coverAsset:
          typeof dto.coverAsset === 'string'
            ? dto.coverAsset
            : dto.coverAsset === null
              ? null
              : existing.coverKey,
      });
      changes.previewAssetUrl = made.previewAsset;
    }
    try {
      return await this.writeEdit(
        id,
        creatorWawuId,
        dto,
        changes,
        coverKey,
        made?.previewAsset,
      );
    } catch (err) {
      // A cut made for an edit that did not go through is given back, so it never counts.
      await this.previews?.giveBack(creatorWawuId, made?.made ?? null);
      throw err;
    }
  }

  /** The write half of `updateMine`: the transaction that lands the edit, then the cover bookkeeping. */
  private async writeEdit(
    id: string,
    creatorWawuId: string,
    dto: UpdateContentDto,
    changes: Prisma.ContentPieceUpdateManyMutationInput,
    coverKey: string | null | undefined,
    madePreview: string | undefined,
  ): Promise<MyContentItem> {
    // Conditional on the status read above: a reviewer approving the piece
    // at this instant must win, and the edit must not land on a live piece.
    const { written, oldCover } = await inPersonsTurn(creatorWawuId, () =>
      this.prisma.$transaction(async (tx) => {
        // A file this edit names must still be the person's (ME-04 round 4).
        await this.assertFilesNotGivenUp(tx, creatorWawuId, [
          dto.previewAsset,
          madePreview,
          dto.fullAsset,
          dto.coverAsset,
        ]);
        await this.assertCoverUsable(tx, creatorWawuId, dto.coverAsset);
        // The cover this edit replaces is read under the person's lock, so a burst of replaces each frees the cover
        // the one before it wrote (read before the lock, the others' covers were never freed).
        let oldCover: string | null = null;
        if (coverKey !== undefined) {
          await lockStorageQuota(tx, creatorWawuId);
          oldCover =
            (
              await tx.contentPiece.findUnique({
                where: { id },
                select: { coverKey: true },
              })
            )?.coverKey ?? null;
        }
        const written = await tx.contentPiece.updateMany({
          where: {
            id,
            creatorWawuId,
            status: { in: ['pending', 'rejected'] },
          },
          data: changes,
        });
        return { written, oldCover };
      }, LOCKED_TX),
    );
    if (written.count === 0) {
      throw new ConflictException(
        'This piece was reviewed a moment ago. Open it again to see where it stands.',
      );
    }
    await this.stampUpdated(this.prisma, id);
    // Replacing a cover, or taking it off, deletes the old file (CONTENT-COVER).
    if (coverKey !== undefined)
      await this.releaseOldCover(creatorWawuId, oldCover, coverKey);
    return this.getMyPiece(id, creatorWawuId);
  }

  /** Records that the creator changed the piece now (HOME-06: "Updated Sep 2026"). */
  private async stampUpdated(
    db: Pick<Prisma.TransactionClient, 'contentDetail'>,
    contentId: string,
  ): Promise<void> {
    const now = new Date();
    await db.contentDetail.upsert({
      where: { contentId },
      create: { contentId, contentUpdatedAt: now },
      update: { contentUpdatedAt: now },
    });
  }

  /**
   * POST /content/:id/resubmit: send a rejected piece for review again.
   *
   * A rejection handed the slot back (admin reject), so sending it again
   * claims one, conditionally and in the same transaction as the status flip,
   * against the same allowance as an upload (TIER-02): without a running
   * tier or a held tick it is refused `tier_required`, and at the limit
   * `product_limit_reached`, the same two answers as POST /content. Pressing it
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

    const allowance = await this.gate.assertRoomForProduct(creatorWawuId);

    await this.refusedWhenPlaceNotClaimed(creatorWawuId, () =>
      this.prisma.$transaction(async (tx) => {
        const flipped = await tx.contentPiece.updateMany({
          where: { id, creatorWawuId, status: 'rejected' },
          data: { status: 'pending' },
        });
        // Lost a race with a second tap: the winner already claimed the slot.
        if (flipped.count === 0) return;
        await this.stampUpdated(tx, id);

        await this.ensureCreatorState(tx, creatorWawuId);
        const claimed = await tx.creatorState.updateMany({
          where: {
            wawuUserId: creatorWawuId,
            slotsUsed: { lt: allowance.productsAllowed },
          },
          data: { slotsUsed: { increment: 1 } },
        });
        if (claimed.count === 0) {
          // Throwing rolls the status flip back with it. The refusal is built
          // after the transaction has ended (ME-04 round 6).
          throw new PlaceNotClaimed();
        }
      }),
    );
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
    await this.blockedAccounts.assertVisible(
      buyerWawuId,
      content.creatorWawuId,
      'Content not found',
    );
    if (content.accessType === 'free') {
      throw new BadRequestException(
        'This content is free, so no unlock is required.',
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
        // ME-10: opening it opens the piece sold; the buyer is the other person.
        about: {
          target: { kind: 'content', id: content.id },
          actorWawuId: purchase.buyerWawuId,
        },
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
      select: { id: true, creatorWawuId: true, status: true },
    });
    if (!content) {
      throw new NotFoundException('Content not found');
    }
    // A piece an account deletion hid can be saved only by its buyers
    // (SETTINGS-06 round 8); every other removed piece is as it was.
    await assertBuyerOnlyIfHidden(
      this.prisma,
      content,
      userWawuId,
      'Content not found',
    );
    await this.blockedAccounts.assertVisible(
      userWawuId,
      content.creatorWawuId,
      'Content not found',
    );

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
    await assertBuyerOnlyIfHidden(
      this.prisma,
      content,
      raterWawuId,
      'Content not found',
    );
    await this.blockedAccounts.assertVisible(
      raterWawuId,
      content.creatorWawuId,
      'Content not found',
    );

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
