import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { PAYMENT_KINDS, type PaymentKind } from '../dto/money-enums';
import type { EarningContentQueryDto } from '../dto/money-request.dto';
import type {
  EarningContentPage,
  EarningContentView,
  EarningsPeriodView,
  EarningsView,
  EarningsWaitingView,
  EarningStreamView,
} from '../money-view.type';
import { decodeEarningCursor, encodeEarningCursor } from './earning-cursor';

export const BAD_EARNINGS_MONTH_MESSAGE = 'month must look like 2026-09';

/** YYYY-MM of `now` in Africa/Lagos time, the month the app calls "this month". */
export function currentLagosMonth(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
  }).format(now);
}

/** A month the database can hold: year 0001 and later. */
function checkedMonth(month: string): string {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000')) {
    throw new BadRequestException(BAD_EARNINGS_MONTH_MESSAGE);
  }
  return month;
}

/** Africa/Lagos midnight on the 1st to the next 1st, as a UTC range over `column`. */
function monthRange(column: Prisma.Sql, month: string): Prisma.Sql {
  const first = `${month}-01`;
  return Prisma.sql`${column} >= ((${first}::timestamp AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'UTC')
    AND ${column} < ((((${first}::date + interval '1 month')::timestamp) AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'UTC')`;
}

/** A kobo figure the database sent as text, as a number a client can hold exactly. */
function kobo(text: string | null | undefined): number {
  const n = Number(text ?? '0');
  if (!Number.isSafeInteger(n)) {
    throw new RangeError('An earning is beyond what a number holds exactly.');
  }
  return n;
}

/**
 * Every earning of one person, from our records of the sales, as one set of
 * rows (`e`): the payee's 85% of
 * - an ordinary sale, once it is finished: an `EarningSettlement` (owed until
 *   the provider confirmed the move into the wallet, then landed);
 * - a held kind (paid DM, ticket), once the owning feature has released its
 *   hold to the payee (`action` is `release`): earned at once. A release made
 *   as an earning (R-55) is an `EarningSettlement` like a sale's and travels
 *   in the payee's move of the day; one made as a transfer of its own (the
 *   hold service's plain release) is landed when the move is confirmed. A
 *   hold whose owner has not decided is `held`, not earned; a refunded one is
 *   the payer's.
 * `at` is when it was earned: the sale's completion, or the release.
 */
function earned(person: string): Prisma.Sql {
  return Prisma.sql`
    SELECT s."kind" AS "kind", s."targetId" AS "targetId", s."title" AS "title",
           s."earnedAt" AS "at", s."amountKobo" AS "kobo",
           (s."status" = 'landed') AS "landed"
      FROM "EarningSettlement" s
     WHERE s."payeeWawuUserId" = ${person}::text
    UNION ALL
    SELECT h."kind", h."targetId", h."title", h."actionAt", h."payeeShareKobo",
           (h."status" = 'released')
      FROM "WalletHold" h
     WHERE h."payeeWawuUserId" = ${person}::text
       AND h."action" = 'release' AND h."payeeShareKobo" > 0
       -- A release that became an earning (R-55) is the earning's row above.
       AND NOT EXISTS (SELECT 1 FROM "EarningSettlement" s
                        WHERE s."paymentId" = h."paymentId")`;
}

type SectionRow = {
  section: 'all' | 'month' | 'waiting' | 'held';
  kind: string | null;
  kobo: string;
  n: string;
};

/**
 * What a person has earned (task WALLET-16, W39), read from our own records
 * of the sales and nothing else: it never calls the wallet provider, and it
 * is not behind the wallet gate, because a creator without a wallet keeps
 * earning and has to see the money waiting for them (R-11).
 *
 * - **Earned is the payee's 85%** (R-5) of each finished sale, in kobo, as
 *   recorded with the payment. A stream and a piece are only ways of adding
 *   the same sales up, so the streams add up to the period's total, and the
 *   pieces of a month add up to the month's, exactly.
 * - **Never a balance.** The figures say what was earned and what is still
 *   waiting to reach the wallet. The wallet's balance is the provider's
 *   (MONEY-11) and is not computed here.
 * - **One snapshot.** The totals, the month, what is waiting and what is
 *   held come from one statement, so they always agree with each other.
 */
@Injectable()
export class EarningsViewService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  async summary(
    wawuUserId: string,
    monthParam: string | undefined,
    now = new Date(),
  ): Promise<EarningsView> {
    const month = checkedMonth(monthParam ?? currentLagosMonth(now));
    const rows = await this.prisma.$queryRaw<SectionRow[]>(Prisma.sql`
      WITH e AS (${earned(wawuUserId)}),
      held AS (
        SELECT h."payeeShareKobo" AS "kobo" FROM "WalletHold" h
         WHERE h."payeeWawuUserId" = ${wawuUserId}::text
           AND h."status" = 'held' AND h."action" IS NULL AND h."payeeShareKobo" > 0
      )
      SELECT 'all' AS "section", e."kind" AS "kind",
             SUM(e."kobo")::text AS "kobo", COUNT(*)::text AS "n"
        FROM e GROUP BY e."kind"
      UNION ALL
      SELECT 'month', e."kind", SUM(e."kobo")::text, COUNT(*)::text
        FROM e WHERE ${monthRange(Prisma.sql`e."at"`, month)} GROUP BY e."kind"
      UNION ALL
      SELECT 'waiting', NULL, COALESCE(SUM(e."kobo"), 0)::text, COUNT(*)::text
        FROM e WHERE NOT e."landed"
      UNION ALL
      SELECT 'held', NULL, COALESCE(SUM(held."kobo"), 0)::text, COUNT(*)::text
        FROM held
    `);
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { provider: true },
    });
    const of = (section: SectionRow['section']) =>
      rows.filter((r) => r.section === section);
    const one = (section: SectionRow['section']): EarningsWaitingView => {
      const r = of(section)[0];
      return { count: kobo(r?.n), amountKobo: kobo(r?.kobo) };
    };
    return {
      allTime: this.period(of('all')),
      month,
      thisMonth: this.period(of('month')),
      waiting: one('waiting'),
      held: one('held'),
      walletOpen: !!wallet && isRowOf(this.provider.name, wallet.provider),
    };
  }

  /** A period's streams, largest first, and their sum. */
  private period(rows: SectionRow[]): EarningsPeriodView {
    const streams: EarningStreamView[] = rows
      .filter((r): r is SectionRow & { kind: string } => r.kind !== null)
      .map((r) => ({
        kind: r.kind as PaymentKind,
        earnedKobo: kobo(r.kobo),
        sales: kobo(r.n),
      }))
      // A kind this version does not know is still money earned: kept, last.
      .sort(
        (a, b) =>
          b.earnedKobo - a.earnedKobo ||
          PAYMENT_KINDS.indexOf(a.kind) - PAYMENT_KINDS.indexOf(b.kind),
      );
    return {
      earnedKobo: streams.reduce((sum, s) => sum + s.earnedKobo, 0),
      sales: streams.reduce((sum, s) => sum + s.sales, 0),
      streams,
    };
  }

  /**
   * One month's earnings piece by piece (W39 "per content"), largest first,
   * then kind, then target. Every page together adds up to the month's total.
   * A piece is whatever was sold: a content piece, a service, a paid-DM
   * thread; the title is the one it had when it last sold.
   */
  async contentPage(
    wawuUserId: string,
    query: Pick<EarningContentQueryDto, 'month' | 'cursor' | 'limit'>,
    now = new Date(),
  ): Promise<EarningContentPage> {
    const month = checkedMonth(query.month ?? currentLagosMonth(now));
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeEarningCursor(query.cursor) : null;
    if (cursor && cursor.month !== month) {
      throw new BadRequestException('cursor is not one this list gave.');
    }
    const after = cursor
      ? Prisma.sql`WHERE g."kobo" < ${cursor.earnedKobo.toString()}::bigint
          OR (g."kobo" = ${cursor.earnedKobo.toString()}::bigint
              AND (g."kind", g."targetId") > (${cursor.kind}::text, ${cursor.targetId}::text))`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        kind: string;
        targetId: string;
        title: string;
        kobo: string;
        n: string;
        lastAt: Date;
      }>
    >(Prisma.sql`
      WITH e AS (${earned(wawuUserId)}),
      g AS (
        SELECT e."kind" AS "kind", e."targetId" AS "targetId",
               (array_agg(e."title" ORDER BY e."at" DESC, e."title"))[1] AS "title",
               SUM(e."kobo")::bigint AS "kobo", COUNT(*) AS "n",
               MAX(e."at") AS "lastAt"
          FROM e
         WHERE ${monthRange(Prisma.sql`e."at"`, month)}
         GROUP BY e."kind", e."targetId"
      )
      SELECT g."kind", g."targetId", g."title", g."kobo"::text AS "kobo",
             g."n"::text AS "n", g."lastAt"
        FROM g ${after}
       ORDER BY g."kobo" DESC, g."kind" ASC, g."targetId" ASC
       LIMIT ${limit + 1}
    `);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const items: EarningContentView[] = page.map((r) => ({
      kind: r.kind as PaymentKind,
      targetId: r.targetId,
      title: r.title,
      earnedKobo: kobo(r.kobo),
      sales: kobo(r.n),
      lastAt: r.lastAt.toISOString(),
    }));
    return {
      month,
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeEarningCursor({
              month,
              earnedKobo: BigInt(last.kobo),
              kind: last.kind as PaymentKind,
              targetId: last.targetId,
            })
          : null,
    };
  }
}
