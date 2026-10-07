import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { FeedCardsService } from '../content-piece/feed-cards.service';
import { StorageService } from '../storage/storage.service';
import { decodeMeCursor, pageOf } from './me-cursor';
import type {
  SavedContentView,
  SavedCreatorState,
  SavedEntryView,
  SavedEventView,
  SavedKind,
  SavedPage,
} from './me-view.type';

type SavedTab = 'all' | 'content' | 'events' | 'creators';

interface SavedRow {
  kind: SavedKind;
  id: string;
  at: Date;
  ref: string;
}

const CREATOR_NOT_FOUND = 'Creator not found.';

/**
 * Saved (M30): content, events and creators the caller saved, newest first,
 * in one list or by tab (task ME-10).
 *
 * WHAT IS LISTED. A save is shown only while the thing is still there for the
 * caller to open:
 *  - a piece while it is `live`;
 *  - an event while it is `published`, or `cancelled` (an event called off
 *    stays readable, so a person sees what became of it);
 *  - a creator while they have a profile.
 * A save of something hidden by a block (SETTINGS-04: the caller blocked its
 * creator, host or the person, or was blocked by them) is not listed and not
 * counted. The save row itself is kept: unblocking brings it back.
 *
 * The rows come from three tables (SavedItem, EventSave, SavedCreator). One
 * SQL statement merges them, so a page is ordered across all three and the
 * cursor is the last row's (savedAt, id).
 */
@Injectable()
export class MeSavedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
    private readonly cards: FeedCardsService,
    private readonly storage: StorageService,
  ) {}

  /** The union of the caller's visible saves, as (kind, id, at, ref). */
  private rowsSql(me: string, hidden: string[], tab: SavedTab): Prisma.Sql {
    const parts: Prisma.Sql[] = [];
    if (tab === 'all' || tab === 'content') {
      parts.push(Prisma.sql`
        SELECT 'content'::text AS "kind", s."id", s."savedAt" AS "at", s."contentId" AS "ref"
        FROM "SavedItem" s
        JOIN "ContentPiece" c ON c."id" = s."contentId"
        WHERE s."userWawuId" = ${me}
          AND c."status" = 'live'
          AND NOT (c."creatorWawuId" = ANY(${hidden}::text[]))`);
    }
    if (tab === 'all' || tab === 'events') {
      parts.push(Prisma.sql`
        SELECT 'event'::text AS "kind", es."id", es."savedAt" AS "at", es."eventId" AS "ref"
        FROM "EventSave" es
        JOIN "Event" e ON e."id" = es."eventId"
        WHERE es."userWawuId" = ${me}
          AND e."status" IN ('published', 'cancelled')
          AND NOT (e."hostWawuId" = ANY(${hidden}::text[]))`);
    }
    if (tab === 'all' || tab === 'creators') {
      parts.push(Prisma.sql`
        SELECT 'creator'::text AS "kind", sc."id", sc."savedAt" AS "at", sc."creatorWawuId" AS "ref"
        FROM "SavedCreator" sc
        JOIN "UserProfile" u ON u."wawuUserId" = sc."creatorWawuId"
        WHERE sc."userWawuId" = ${me}
          AND NOT (sc."creatorWawuId" = ANY(${hidden}::text[]))`);
    }
    return Prisma.join(parts, ' UNION ALL ');
  }

  /** M7's "Saved 31": what GET /me/saved would list in full. */
  async count(me: string): Promise<number> {
    const hidden = await this.blocked.hiddenFrom(me);
    const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "n" FROM (${this.rowsSql(me, hidden, 'all')}) x`);
    return Number(row?.n ?? 0);
  }

  /** GET /me/saved. */
  async list(
    me: string,
    tab: SavedTab,
    rawCursor: string | undefined,
    limit: number,
  ): Promise<SavedPage> {
    const cursor = decodeMeCursor(rawCursor);
    const hidden = await this.blocked.hiddenFrom(me);
    const after = cursor
      ? Prisma.sql`WHERE (x."at", x."id") < ((${cursor.at.toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::text)`
      : Prisma.empty;
    const fetched = await this.prisma.$queryRaw<SavedRow[]>(Prisma.sql`
      SELECT x."kind", x."id", x."at", x."ref"
      FROM (${this.rowsSql(me, hidden, tab)}) x
      ${after}
      ORDER BY x."at" DESC, x."id" DESC
      LIMIT ${limit + 1}`);
    const { rows, nextCursor } = pageOf(fetched, limit, (r) => r);

    const ids = (kind: SavedKind) =>
      rows.filter((r) => r.kind === kind).map((r) => r.ref);
    const [pieces, events, bought] = await Promise.all([
      this.prisma.contentPiece.findMany({
        where: { id: { in: ids('content') } },
        select: {
          id: true,
          title: true,
          contentType: true,
          accessType: true,
          price: true,
          previewAssetUrl: true,
          creatorWawuId: true,
        },
      }),
      this.prisma.event.findMany({
        where: { id: { in: ids('event') } },
        select: {
          id: true,
          name: true,
          startsAt: true,
          endsAt: true,
          location: true,
          bannerUrl: true,
          status: true,
        },
      }),
      this.prisma.purchase.findMany({
        where: {
          buyerWawuId: me,
          type: 'content',
          status: 'completed',
          contentId: { in: ids('content') },
        },
        select: { contentId: true },
      }),
    ]);
    const people = await this.cards.creatorsFor([
      ...pieces.map((p) => p.creatorWawuId),
      ...ids('creator'),
    ]);
    const boughtIds = new Set(bought.map((b) => b.contentId));
    const pieceById = new Map<string, SavedContentView>();
    for (const p of pieces) {
      pieceById.set(p.id, {
        id: p.id,
        title: p.title,
        contentType: p.contentType,
        accessType: p.accessType,
        priceKobo: p.accessType === 'free' ? null : p.price * 100,
        thumbnailUrl: await this.storage.freshUrlFor(p.previewAssetUrl),
        bought: boughtIds.has(p.id),
        creator: people.get(p.creatorWawuId)!,
      });
    }
    const eventById = new Map<string, SavedEventView>(
      events.map((e) => [
        e.id,
        {
          id: e.id,
          name: e.name,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt ? e.endsAt.toISOString() : null,
          location: e.location,
          bannerUrl: e.bannerUrl,
          status: e.status === 'cancelled' ? 'cancelled' : 'published',
        },
      ]),
    );

    const items: SavedEntryView[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      savedAt: r.at.toISOString(),
      content: r.kind === 'content' ? (pieceById.get(r.ref) ?? null) : null,
      event: r.kind === 'event' ? (eventById.get(r.ref) ?? null) : null,
      creator: r.kind === 'creator' ? (people.get(r.ref) ?? null) : null,
    }));
    return { items, nextCursor };
  }

  /**
   * PUT /me/saved/creators/:wawuId. Idempotent: saving again keeps the first
   * save's time. Nobody saves themselves; a person with no profile, or one a
   * block hides from the caller, is the same 404.
   */
  async saveCreator(
    me: string,
    creatorWawuId: string,
  ): Promise<SavedCreatorState> {
    if (creatorWawuId === me) {
      throw new BadRequestException('You cannot save yourself.');
    }
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { wawuUserId: true },
    });
    if (!profile) throw new NotFoundException(CREATOR_NOT_FOUND);
    await this.blocked.assertVisible(me, creatorWawuId, CREATOR_NOT_FOUND);
    await this.prisma.savedCreator.createMany({
      data: [{ userWawuId: me, creatorWawuId }],
      skipDuplicates: true,
    });
    return { creatorWawuId, saved: true };
  }

  /** DELETE /me/saved/creators/:wawuId. Removing a save that is not there is the same success. */
  async unsaveCreator(
    me: string,
    creatorWawuId: string,
  ): Promise<SavedCreatorState> {
    await this.prisma.savedCreator.deleteMany({
      where: { userWawuId: me, creatorWawuId },
    });
    return { creatorWawuId, saved: false };
  }
}
