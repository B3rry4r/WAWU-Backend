import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeedCardsService } from '../content-piece/feed-cards.service';
import { packOf, PACK_TABLE } from '../credit-purchase/credit-packs';
import { StorageService } from '../storage/storage.service';
import { decodeMeCursor, pageOf } from './me-cursor';
import { MePurchasesService } from './me-purchases.service';
import type {
  PaidPurchaseKind,
  PaidPurchasePage,
  PaidPurchaseStatus,
  PaidPurchaseView,
} from './me-view.type';

/** How many handles a search may match before the title match alone is used. */
const HANDLE_MATCH_LIMIT = 200;

/** LIKE's own characters, as plain text (Postgres' default escape is a backslash). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One row as the union query gives it (every figure in integer kobo). */
interface PaidRow {
  kind: PaidPurchaseKind;
  id: string;
  at: Date;
  title: string;
  amountKobo: bigint;
  totalKobo: bigint | null;
  status: PaidPurchaseStatus;
  targetId: string;
  credits: number | null;
  sellerId: string | null;
}

/** What a content row adds to the table's columns. */
type PieceDetail = Pick<PaidPurchaseView, 'content' | 'lessons'>;

/** A kobo figure as a number; a figure past 2^53 is a corrupt row, never a rounded one. */
function koboNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error('A purchase amount is too large to send as a number.');
  }
  return n;
}

/** The credits in a pack row: the purchase's own count, else the pack the paid-back payment named. */
function creditsOf(row: PaidRow): number | null {
  if (row.credits !== null) return row.credits;
  const pack = packOf(row.targetId);
  return pack ? PACK_TABLE[pack].credits : null;
}

/**
 * My purchases across every paid kind (M29, task FIX-59, BACKEND_GAPS
 * G-ME-14-1). `GET /me/purchases` lists the pieces a person unlocked and is
 * left exactly as it was; this is the merged read beside it.
 *
 * ONE ROW PER PURCHASE, FROM THE RECORD THAT OWNS IT. Each purchase comes
 * from exactly one of the queries below, so a kind is never listed twice:
 *
 * - `content_unlock`: a completed content `Purchase` (the card or the wallet
 *   wrote it); a wallet unlock that could not be delivered and was paid back
 *   has no `Purchase` and is listed from its payment as refunded.
 * - `event_ticket`: an `EventOrder` that took money (`paid` or `refunded`; an
 *   order that failed after the money moved is listed once it is paid back).
 *   A free order (₦0) took nothing and is not a purchase.
 * - `credit_pack`: a completed `CreditPurchase`; a pack paid back is listed
 *   from its payment as refunded.
 * - `school_fee`, `community_pass` and `legal_fee`: the completed wallet
 *   payment itself (none has a card path, and a pass has no table on every
 *   server yet). A legal fee (R2-MONEY2) opens its request.
 *
 * AMOUNTS ARE THE PAYMENT'S OWN. A wallet payment's price and total are
 * columns of that payment; a card charge keeps its whole-naira amount, shown
 * in kobo by the unit alone. Nothing is added up or recomputed.
 *
 * Only the caller's own rows, by the buyer column of each table. Pending and
 * failed charges are not purchases. Tips, paid questions, bills, plans and
 * verification are not purchases of an item and stay in the wallet history.
 * As on `/me/purchases`, a block does not hide what a person paid for.
 */
@Injectable()
export class MePaidPurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchases: MePurchasesService,
    private readonly cards: FeedCardsService,
    private readonly storage: StorageService,
  ) {}

  /** GET /me/purchases/all. */
  async list(
    me: string,
    q: string | undefined,
    rawCursor: string | undefined,
    limit: number,
  ): Promise<PaidPurchasePage> {
    const cursor = decodeMeCursor(rawCursor);

    const conditions: Prisma.Sql[] = [];
    if (q) {
      // % and _ are escaped, so they match only as characters.
      const text = escapeLike(q);
      const pattern = `%${text}%`;
      const handles = await this.prisma.userProfile.findMany({
        where: { handle: { contains: text, mode: 'insensitive' } },
        select: { wawuUserId: true },
        take: HANDLE_MATCH_LIMIT,
      });
      const sellers = handles.map((h) => h.wawuUserId);
      // A piece is also found by its creator's handle, as on /me/purchases.
      conditions.push(
        Prisma.sql`(u."title" ILIKE ${pattern} ESCAPE '\\'
          OR (u."kind" = 'content_unlock' AND u."sellerId" = ANY(${sellers}::text[])))`,
      );
    }
    if (cursor) {
      conditions.push(
        Prisma.sql`(u."at", u."id") < ((${cursor.at.toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::text)`,
      );
    }
    const where =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const fetched = await this.prisma.$queryRaw<PaidRow[]>(Prisma.sql`
      SELECT u.* FROM (${this.union(me)}) u
      ${where}
      ORDER BY u."at" DESC, u."id" DESC
      LIMIT ${limit + 1}
    `);
    const { rows, nextCursor } = pageOf(fetched, limit, (r) => ({
      at: r.at,
      id: r.id,
    }));

    const details = await this.pieceDetails(
      me,
      rows.filter((r) => r.kind === 'content_unlock').map((r) => r.targetId),
    );
    const items: PaidPurchaseView[] = rows.map((r) => {
      const detail =
        r.kind === 'content_unlock' ? details.get(r.targetId) : undefined;
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        amountKobo: koboNumber(r.amountKobo),
        totalKobo: r.totalKobo === null ? null : koboNumber(r.totalKobo),
        purchasedAt: r.at.toISOString(),
        status: r.status,
        openId: r.kind === 'credit_pack' ? null : r.targetId,
        content: detail?.content ?? null,
        lessons: detail?.lessons ?? null,
        credits: r.kind === 'credit_pack' ? creditsOf(r) : null,
      };
    });
    return { items, nextCursor };
  }

  /**
   * The caller's purchases as one table: a row per purchase with the columns
   * `PaidRow` names. Times are the purchase's (a refunded row keeps the day
   * it was paid).
   */
  private union(me: string): Prisma.Sql {
    return Prisma.sql`
      -- A piece unlocked: the card or the wallet wrote a completed Purchase.
      SELECT 'content_unlock'::text AS "kind", p."id"::text AS "id",
             p."purchasedAt" AS "at", c."title" AS "title",
             COALESCE(w."priceKobo", p."amount"::bigint * 100) AS "amountKobo",
             w."totalKobo" AS "totalKobo", 'paid'::text AS "status",
             c."id"::text AS "targetId", NULL::int AS "credits",
             c."creatorWawuId"::text AS "sellerId"
        FROM "Purchase" p
        JOIN "ContentPiece" c ON c."id" = p."contentId"
        LEFT JOIN "WalletPayment" w
          ON p."flutterwaveTxRef" LIKE 'wallet:%'
         AND w."id" = substr(p."flutterwaveTxRef", 8)
       WHERE p."buyerWawuId" = ${me} AND p."type" = 'content'
         AND p."status" = 'completed'
      UNION ALL
      -- A wallet unlock that could not be delivered and was paid back.
      SELECT 'content_unlock', w."id", COALESCE(w."completedAt", w."createdAt"),
             w."title", w."priceKobo", w."totalKobo", 'refunded',
             w."targetId", NULL::int, w."payeeWawuUserId"
        FROM "WalletPayment" w
        JOIN "WalletHold" h ON h."paymentId" = w."id" AND h."status" = 'refunded'
       WHERE w."payerWawuUserId" = ${me} AND w."kind" = 'content_unlock'
         AND w."status" = 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM "Purchase" p
            WHERE p."flutterwaveTxRef" = 'wallet:' || w."id"
              AND p."status" = 'completed')
      UNION ALL
      -- Tickets: an order that took money (the web's card orders and wallet orders).
      SELECT 'event_ticket', o."id", COALESCE(o."paidAt", o."createdAt"),
             e."name", COALESCE(w."priceKobo", o."amountNaira"::bigint * 100),
             w."totalKobo",
             CASE WHEN o."status" = 'refunded' OR h."status" = 'refunded'
                  THEN 'refunded' ELSE 'paid' END,
             o."id", NULL::int, NULL::text
        FROM "EventOrder" o
        JOIN "Event" e ON e."id" = o."eventId"
        LEFT JOIN "WalletPayment" w ON w."id" = o."walletPaymentId"
        LEFT JOIN "WalletHold" h ON h."paymentId" = o."walletPaymentId"
       WHERE o."buyerWawuId" = ${me} AND o."amountNaira" > 0
         AND (o."status" IN ('paid', 'refunded')
              OR (o."status" = 'failed' AND h."status" = 'refunded'))
      UNION ALL
      -- Credit packs: a completed purchase (card or wallet).
      SELECT 'credit_pack', cp."id", cp."purchasedAt",
             cp."creditsGranted"::text || ' WAWU Credits',
             COALESCE(w."priceKobo", cp."amount"::bigint * 100),
             w."totalKobo", 'paid', cp."id", cp."creditsGranted", NULL::text
        FROM "CreditPurchase" cp
        LEFT JOIN "WalletPayment" w ON w."id" = cp."walletPaymentId"
       WHERE cp."userWawuId" = ${me} AND cp."status" = 'completed'
      UNION ALL
      -- A wallet pack that could not be delivered and was paid back.
      SELECT 'credit_pack', w."id", COALESCE(w."completedAt", w."createdAt"),
             w."title", w."priceKobo", w."totalKobo", 'refunded',
             w."targetId", NULL::int, NULL::text
        FROM "WalletPayment" w
        JOIN "WalletHold" h ON h."paymentId" = w."id" AND h."status" = 'refunded'
       WHERE w."payerWawuUserId" = ${me} AND w."kind" = 'credit_pack'
         AND w."status" = 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM "CreditPurchase" cp WHERE cp."walletPaymentId" = w."id")
      UNION ALL
      -- School fees and community passes: the wallet payment is the record.
      -- A refund still on its way, not yet confirmed by the provider, waits
      -- unlisted unless the place itself already says refunded.
      SELECT w."kind", w."id", COALESCE(w."completedAt", w."createdAt"),
             w."title", w."priceKobo", w."totalKobo",
             CASE WHEN h."status" = 'refunded' OR s."status" = 'refunded'
                  THEN 'refunded' ELSE 'paid' END,
             w."targetId", NULL::int, NULL::text
        FROM "WalletPayment" w
        LEFT JOIN "WalletHold" h ON h."paymentId" = w."id"
        LEFT JOIN "SchoolEnrolment" s
          ON w."kind" = 'school_fee' AND s."id" = w."targetId"
       WHERE w."payerWawuUserId" = ${me}
         AND w."kind" IN ('school_fee', 'community_pass', 'legal_fee')
         AND w."status" = 'completed'
         AND (h."id" IS NULL OR h."action" IS DISTINCT FROM 'refund'
              OR h."status" = 'refunded' OR s."status" = 'refunded')
    `;
  }

  /** What M29 draws for a piece (creator, type, picture) and a course's progress, for a page's pieces. */
  private async pieceDetails(
    me: string,
    contentIds: string[],
  ): Promise<Map<string, PieceDetail>> {
    const out = new Map<string, PieceDetail>();
    if (contentIds.length === 0) return out;
    const pieces = await this.prisma.contentPiece.findMany({
      where: { id: { in: contentIds } },
      select: {
        id: true,
        title: true,
        contentType: true,
        previewAssetUrl: true,
        creatorWawuId: true,
      },
    });
    const courseIds = pieces
      .filter((p) => p.contentType === 'course')
      .map((p) => p.id);
    const [people, progress] = await Promise.all([
      this.cards.creatorsFor(pieces.map((p) => p.creatorWawuId)),
      this.purchases.progressFor(me, courseIds),
    ]);
    for (const p of pieces) {
      out.set(p.id, {
        content: {
          id: p.id,
          title: p.title,
          contentType: p.contentType,
          thumbnailUrl: await this.storage.freshUrlFor(p.previewAssetUrl),
          creator: people.get(p.creatorWawuId)!,
        },
        lessons:
          p.contentType === 'course'
            ? (progress.get(p.id) ?? { total: 0, done: 0 })
            : null,
      });
    }
    return out;
  }
}
