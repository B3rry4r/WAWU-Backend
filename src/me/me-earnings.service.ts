import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { STREAM_DEFINITIONS } from '../admin/finance/finance-streams';
import { decodeMeCursor, pageOf } from './me-cursor';
import type {
  EarningSalePage,
  EarningSaleView,
  EarningStream,
  EarningsMonthView,
  MyEarningsView,
} from './me-view.type';

/** How many months M18's bars show, ending with the month asked for. */
const BAR_MONTHS = 12;

/**
 * What a paid question pays its creator, in percent. DirectMessage stores no
 * rate of its own, so the one split (R-5, 85/15) is read from the stream
 * table every finance screen reads, exactly as GET /content/mine/earnings
 * applies the current rate to paid DMs.
 */
const PAID_QUESTION_CREATOR_PCT = STREAM_DEFINITIONS.dm.creatorSharePct;

/** Africa/Lagos is UTC+1 all year (no daylight saving). */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

interface EarnedSaleRow {
  id: string;
  stream: EarningStream;
  earned: bigint;
  at: Date;
  title: string | null;
  contentId: string | null;
}

/** YYYY-MM of an instant, in Africa/Lagos. */
export function lagosMonthOf(instant: Date): string {
  const local = new Date(instant.getTime() + LAGOS_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month `delta` months from `month` (YYYY-MM). */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The UTC instant a Lagos month starts at. */
function lagosMonthStart(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - LAGOS_OFFSET_MS);
}

/**
 * This month's earnings (M7 "₦128,400 this month", M18 "Earned in September",
 * its bars and "+18%"), task ME-10.
 *
 * WHAT IS COUNTED. The caller's own completed sales, from our own records of
 * them, with the creator's share each record already defines:
 *  - content unlocks and tips: `Purchase` rows `completed`, at `purchasedAt`,
 *    the share being the amount less the row's snapshotted `commissionRate`;
 *  - paid questions: `DirectMessage` rows `responded` (the reply is what
 *    earns it; one still awaiting a reply is held, a refunded one was never
 *    the creator's), at `respondedAt`, 85% (R-5);
 *  - WAWU Credits spent in the creator's rooms: `CreditSpendEarning`, at
 *    `earnedAt`, its `hostShareKobo` as stored. A spend that earned nothing
 *    (credits WAWU was paid nothing for) is not a sale and is left out.
 * These are the streams and rules GET /content/mine/earnings already uses,
 * with held paid questions left out because they are not completed.
 *
 * WHAT IT IS NOT. Never a balance: what the wallet holds is the provider's
 * figure alone (CONVENTIONS section 1). Nothing here reads a wallet, the
 * ledger of wallet movements or the provider. Event ticket sales are not in
 * it, as they are not in GET /content/mine/earnings (BACKEND_GAPS, ME-10).
 *
 * A month is Africa/Lagos (CONVENTIONS section 7); a share is floored to the
 * kobo, as `splitKoboByBps` does.
 */
@Injectable()
export class MeEarningsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every completed sale of `me` from `from` (inclusive) to `to` (exclusive). */
  private salesSql(me: string, from: Date, to: Date): Prisma.Sql {
    const lo = Prisma.sql`(${from.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    const hi = Prisma.sql`(${to.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    return Prisma.sql`
      SELECT p."id",
             (CASE WHEN p."type" = 'tip' THEN 'tip' ELSE 'content' END)::text AS "stream",
             FLOOR(p."amount"::numeric * 100 * (1 - p."commissionRate"))::bigint AS "earned",
             p."purchasedAt" AS "at",
             c."title" AS "title",
             p."contentId" AS "contentId"
      FROM "Purchase" p
      LEFT JOIN "ContentPiece" c ON c."id" = p."contentId"
      WHERE p."creatorWawuId" = ${me}
        AND p."status" = 'completed'
        AND p."type" IN ('content', 'tip')
        AND p."purchasedAt" >= ${lo} AND p."purchasedAt" < ${hi}
      UNION ALL
      SELECT d."id",
             'paid_question'::text,
             FLOOR(d."amount"::numeric * ${PAID_QUESTION_CREATOR_PCT})::bigint,
             COALESCE(d."respondedAt", d."sentAt"),
             NULL::text,
             NULL::text
      FROM "DirectMessage" d
      WHERE d."creatorWawuId" = ${me}
        AND d."status" = 'responded'
        AND COALESCE(d."respondedAt", d."sentAt") >= ${lo}
        AND COALESCE(d."respondedAt", d."sentAt") < ${hi}
      UNION ALL
      SELECT e."id",
             'community_credits'::text,
             e."hostShareKobo"::bigint,
             e."earnedAt",
             cm."name",
             NULL::text
      FROM "CreditSpendEarning" e
      LEFT JOIN "Community" cm ON cm."id" = e."communityId"
      WHERE e."creatorWawuId" = ${me}
        AND e."hostShareKobo" > 0
        AND e."earnedAt" >= ${lo} AND e."earnedAt" < ${hi}`;
  }

  /** `month`, or this Lagos month. */
  private monthOrNow(month: string | undefined): string {
    return month ?? lagosMonthOf(new Date());
  }

  /** GET /me/earnings. */
  async summary(
    me: string,
    monthAsked: string | undefined,
  ): Promise<MyEarningsView> {
    const month = this.monthOrNow(monthAsked);
    const first = shiftMonth(month, -(BAR_MONTHS - 1));
    const from = lagosMonthStart(first);
    const to = lagosMonthStart(shiftMonth(month, 1));
    const grouped = await this.prisma.$queryRaw<
      { month: string; earned: bigint; sales: bigint }[]
    >(Prisma.sql`
      SELECT to_char(("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') AS "month",
             SUM("earned")::bigint AS "earned",
             COUNT(*)::bigint AS "sales"
      FROM (${this.salesSql(me, from, to)}) s
      GROUP BY 1`);
    const byMonth = new Map(grouped.map((g) => [g.month, g]));
    const months: EarningsMonthView[] = [];
    for (let i = 0; i < BAR_MONTHS; i += 1) {
      const m = shiftMonth(first, i);
      months.push({
        month: m,
        earnedKobo: Number(byMonth.get(m)?.earned ?? 0),
      });
    }
    const previousMonth = shiftMonth(month, -1);
    const earnedKobo = Number(byMonth.get(month)?.earned ?? 0);
    const previousEarnedKobo = Number(byMonth.get(previousMonth)?.earned ?? 0);
    return {
      month,
      earnedKobo,
      salesCount: Number(byMonth.get(month)?.sales ?? 0),
      previousMonth,
      previousEarnedKobo,
      changePct:
        previousEarnedKobo === 0
          ? null
          : Math.round(
              ((earnedKobo - previousEarnedKobo) * 100) / previousEarnedKobo,
            ),
      months,
    };
  }

  /** GET /me/earnings/sales: that month's completed sales, newest first. */
  async sales(
    me: string,
    monthAsked: string | undefined,
    rawCursor: string | undefined,
    limit: number,
  ): Promise<EarningSalePage> {
    const month = this.monthOrNow(monthAsked);
    const cursor = decodeMeCursor(rawCursor);
    const after = cursor
      ? Prisma.sql`WHERE (s."at", s."id") < ((${cursor.at.toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::text)`
      : Prisma.empty;
    const fetched = await this.prisma.$queryRaw<EarnedSaleRow[]>(Prisma.sql`
      SELECT s."id", s."stream", s."earned", s."at", s."title", s."contentId"
      FROM (${this.salesSql(me, lagosMonthStart(month), lagosMonthStart(shiftMonth(month, 1)))}) s
      ${after}
      ORDER BY s."at" DESC, s."id" DESC
      LIMIT ${limit + 1}`);
    const { rows, nextCursor } = pageOf(fetched, limit, (r) => r);
    const items: EarningSaleView[] = rows.map((r) => ({
      id: r.id,
      stream: r.stream,
      earnedKobo: Number(r.earned),
      occurredAt: r.at.toISOString(),
      title: r.title,
      contentId: r.contentId,
    }));
    return { month, items, nextCursor };
  }
}
