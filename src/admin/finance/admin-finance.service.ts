import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import {
  ADMIN_FINANCE_STREAMS,
  type AdminFinanceCreditsAttributionView,
  type AdminFinanceMoneyView,
  type AdminFinancePartyView,
  type AdminFinancePeriodView,
  type AdminFinanceStream,
  type AdminFinanceStreamTotalsView,
  type AdminFinanceSummaryView,
  type AdminFinanceTransactionView,
  type AdminFinanceTxStatus,
} from './admin-finance-view.type';
import {
  CREDITS_COMMISSION_RATE,
  STANDARD_COMMISSION_RATE,
  STREAM_DEFINITIONS,
  currentCalendarMonth,
  nairaToKobo,
  splitKobo,
  splitKoboByBps,
} from './finance-streams';
import type { AdminFinancePeriodQueryDto } from './dto/admin-finance-period-query.dto';
import type { AdminFinanceTransactionsQueryDto } from './dto/admin-finance-transactions-query.dto';

/** What every response on this surface says about itself. */
const SUMMARY_BASIS =
  'Gross is money WAWU actually collected in the period, counting only settled charges. The creator share is what the split owes a creator, not what has reached their wallet - see GET /admin/finance/payouts for that.';

const CREDITS_ATTRIBUTION_NOTE =
  'A credit pack is banked at purchase and the host share is attributed later, one spent credit at a time, against the CreditLot that funded it. The credits stream above reports the money taken in this period at the platform split; these figures report what was actually attributed to hosts in the same period, which covers credits bought earlier.';

/** A row of the flattened cross-stream ledger, as Postgres hands it back. */
interface LedgerRow {
  stream: AdminFinanceStream;
  id: string;
  occurredAt: Date;
  creatorWawuId: string | null;
  buyerWawuId: string | null;
  grossNaira: number;
  /** WAWU's cut in basis points, from the row's own snapshot where it has one. */
  commissionBps: number;
  sourceStatus: string;
  normStatus: AdminFinanceTxStatus;
  txRef: string | null;
  txId: string | null;
}

/**
 * THE ADMIN MONEY SURFACE, READ-ONLY.
 *
 * `@Controller('admin/payments')` served webhook receipts and DM refunds and
 * nothing else, so no endpoint anywhere answered what the platform has taken,
 * what WAWU's share of it is, what creators are owed, or what has passed
 * through. `/wallet` and `/content/mine/earnings` answer those questions for
 * the CALLER's own account, which is no use to an operator holding the whole
 * platform's books.
 *
 * ── SIX TABLES, ONE VOCABULARY ───────────────────────────────────────────
 * Money enters this platform through six unrelated tables, each with its own
 * lifecycle enum and its own name for the amount column. This service
 * flattens them into one shape without changing any of them: every row keeps
 * its native status on `sourceStatus`, and `normStatus` is the flattened
 * word the filters act on. The mapping is in finance-streams.ts and is total
 * over every enum, so no status can fall through and be counted as revenue by
 * accident.
 *
 * ── WHAT IS NEVER DONE HERE ──────────────────────────────────────────────
 * No figure on this surface is a wallet balance. A creator's wallet is a
 * Flutterwave payout subaccount in their own name, custodied by Flutterwave
 * under their CBN licence, and Flutterwave's number is the only authoritative
 * one. Everything this service produces is a sum of rows WAWU wrote, and is
 * labelled as one. The live balance is fetched from the wallet module's own
 * gateway, in AdminFinanceWalletsService, and nowhere else.
 *
 * ── AND NOTHING IS WRITTEN ───────────────────────────────────────────────
 * Every handler is a GET. There is deliberately no adjust, no credit, no
 * reverse and no override: a wrong figure is a defect at its source, and an
 * admin write path over a creator's wallet is a fraud surface that would let
 * one compromised operator account move real money out of accounts WAWU does
 * not even custody.
 */
@Injectable()
export class AdminFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  // ── GET /admin/finance/summary ────────────────────────────────────────────

  /**
   * Gross, WAWU's share, the creators' share and a count, per revenue stream,
   * for a window that defaults to this calendar month.
   *
   * Every stream is summed IN POSTGRES. The purchase and event streams are
   * grouped by the rate SNAPSHOTTED on each row, never the current one, so a
   * rate change can never retroactively move what a past sale paid - which is
   * the whole reason those columns exist.
   */
  async summary(
    query: AdminFinancePeriodQueryDto,
    now: Date = new Date(),
  ): Promise<AdminFinanceSummaryView> {
    const period = resolvePeriod(query.from, query.to, now);
    const range = { gte: period.from, lt: period.to };

    const [
      purchaseGroups,
      dmTotals,
      creditTotals,
      verificationTotals,
      eventGroups,
      shopTotals,
      creditAttribution,
    ] = await Promise.all([
      this.prisma.purchase.groupBy({
        by: ['type', 'commissionRate'],
        where: { status: 'completed', purchasedAt: range },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      // A DirectMessage row is only written once its charge verified, so
      // existence IS settlement. `refunded` is money returned to the sender
      // and is counted as nothing, the same way the creator's own earnings
      // screen counts it.
      this.prisma.directMessage.aggregate({
        where: {
          status: { in: ['awaiting_response', 'responded'] },
          sentAt: range,
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.creditPurchase.aggregate({
        where: { status: 'completed', purchasedAt: range },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.verificationPurchase.aggregate({
        where: { status: 'completed', createdAt: range },
        _sum: { priceNgn: true },
        _count: { _all: true },
      }),
      this.prisma.eventOrder.groupBy({
        by: ['commissionRate'],
        where: { status: 'paid', createdAt: range },
        _sum: { amountNaira: true },
        _count: { _all: true },
      }),
      this.prisma.shopOrder.aggregate({
        where: { status: 'paid', createdAt: range },
        _sum: { totalNaira: true },
        _count: { _all: true },
      }),
      this.prisma.creditSpendEarning.aggregate({
        where: { earnedAt: range },
        _sum: {
          creditsSpent: true,
          creditsFunded: true,
          grossKobo: true,
          hostShareKobo: true,
          platformShareKobo: true,
        },
      }),
    ]);

    const blank = (): AdminFinanceMoneyView => ({
      grossKobo: 0,
      wawuShareKobo: 0,
      creatorShareKobo: 0,
      transactionCount: 0,
    });
    const money: Record<AdminFinanceStream, AdminFinanceMoneyView> = {
      content: blank(),
      tips: blank(),
      dm: blank(),
      credits: blank(),
      verification: blank(),
      events: blank(),
      shop: blank(),
    };

    for (const group of purchaseGroups) {
      const target = group.type === 'content' ? money.content : money.tips;
      addInto(
        target,
        nairaToKobo(group._sum.amount ?? 0),
        Number(group.commissionRate),
        group._count._all,
      );
    }

    addInto(
      money.dm,
      nairaToKobo(dmTotals._sum.amount ?? 0),
      STANDARD_COMMISSION_RATE,
      dmTotals._count._all,
    );
    addInto(
      money.credits,
      nairaToKobo(creditTotals._sum.amount ?? 0),
      CREDITS_COMMISSION_RATE,
      creditTotals._count._all,
    );
    // A tick is paid to the platform with no creator on the other side, so
    // the commission is the whole of it. This is not an invented rate: it is
    // the absence of a counterparty, which VerificationPurchase's own schema
    // comment spells out.
    addInto(
      money.verification,
      nairaToKobo(verificationTotals._sum.priceNgn ?? 0),
      1,
      verificationTotals._count._all,
    );
    for (const group of eventGroups) {
      addInto(
        money.events,
        nairaToKobo(group._sum.amountNaira ?? 0),
        Number(group.commissionRate),
        group._count._all,
      );
    }
    // Products are WAWU's own catalogue - Product carries no seller column -
    // so there is no creator share to compute.
    addInto(
      money.shop,
      nairaToKobo(shopTotals._sum.totalNaira ?? 0),
      1,
      shopTotals._count._all,
    );

    const streams: AdminFinanceStreamTotalsView[] = ADMIN_FINANCE_STREAMS.map(
      (stream) => ({
        stream,
        label: STREAM_DEFINITIONS[stream].label,
        creatorSharePct: STREAM_DEFINITIONS[stream].creatorSharePct,
        source: STREAM_DEFINITIONS[stream].source,
        countedStatuses: [...STREAM_DEFINITIONS[stream].countedStatuses],
        ...money[stream],
      }),
    );

    const totals = streams.reduce<AdminFinanceMoneyView>(
      (acc, s) => ({
        grossKobo: acc.grossKobo + s.grossKobo,
        wawuShareKobo: acc.wawuShareKobo + s.wawuShareKobo,
        creatorShareKobo: acc.creatorShareKobo + s.creatorShareKobo,
        transactionCount: acc.transactionCount + s.transactionCount,
      }),
      blank(),
    );

    const attribution: AdminFinanceCreditsAttributionView = {
      note: CREDITS_ATTRIBUTION_NOTE,
      creditsSpent: creditAttribution._sum.creditsSpent ?? 0,
      creditsFunded: creditAttribution._sum.creditsFunded ?? 0,
      fundedGrossKobo: creditAttribution._sum.grossKobo ?? 0,
      hostShareKobo: creditAttribution._sum.hostShareKobo ?? 0,
      platformShareKobo: creditAttribution._sum.platformShareKobo ?? 0,
    };

    return {
      period: toPeriodView(period),
      currency: 'NGN',
      amountsIn: 'kobo',
      totals,
      streams,
      creditsAttribution: attribution,
      basis: SUMMARY_BASIS,
    };
  }

  // ── GET /admin/finance/transactions ───────────────────────────────────────

  /**
   * One row per money movement, across all six tables, newest first.
   *
   * Raw SQL, and it has to be. The six source tables share no relation and no
   * common parent - Prisma cannot express "the union of these, ordered by a
   * column each of them spells differently, then page 3 of it". Merging six
   * paged reads in JavaScript gives the wrong page boundaries; merging six
   * UNPAGED reads loads the platform's entire payment history into memory.
   * The UNION does the ordering and the paging in Postgres, where the indexes
   * are.
   *
   * Every value is a bound parameter (Prisma.sql tagged templates), so no
   * filter value is ever concatenated into the statement.
   */
  async transactions(
    query: AdminFinanceTransactionsQueryDto,
  ): Promise<Paginated<AdminFinanceTransactionView>> {
    const period = resolvePeriod(query.from, query.to, new Date());
    const branches = this.ledgerBranches(query, period);

    if (branches.length === 0) {
      return {
        items: [],
        currentPage: query.page,
        perPage: query.perPage,
        total: 0,
      };
    }

    const union = Prisma.join(branches, ' UNION ALL ');
    const statusFilter =
      query.status && query.status.length > 0
        ? Prisma.sql`WHERE t."normStatus" IN (${Prisma.join(query.status)})`
        : Prisma.empty;
    const direction =
      query.sort === 'oldest' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<LedgerRow[]>(Prisma.sql`
        SELECT t.* FROM (${union}) t
        ${statusFilter}
        ORDER BY t."occurredAt" ${direction}, t."id" ASC
        LIMIT ${query.perPage} OFFSET ${(query.page - 1) * query.perPage}
      `),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS total FROM (${union}) t ${statusFilter}
      `),
    ]);

    const handles = await this.resolveHandles(
      rows.flatMap((r) => [r.creatorWawuId, r.buyerWawuId]),
    );

    const items = rows.map((row) => {
      const grossKobo = nairaToKobo(row.grossNaira);
      const { wawuShareKobo, creatorShareKobo } = splitKoboByBps(
        grossKobo,
        10_000 - row.commissionBps,
      );
      return {
        id: row.id,
        stream: row.stream,
        occurredAt: row.occurredAt.toISOString(),
        creator: party(row.creatorWawuId, handles),
        buyer: party(row.buyerWawuId, handles),
        grossKobo,
        wawuShareKobo,
        creatorShareKobo,
        status: row.normStatus,
        sourceStatus: row.sourceStatus,
        flutterwaveTxRef: row.txRef,
        flutterwaveTxId: row.txId,
      };
    });

    return {
      items,
      currentPage: query.page,
      perPage: query.perPage,
      total: counted[0]?.total ?? 0,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * One SELECT per requested stream, each already narrowed by period and by
   * creator, each emitting the identical column list the UNION needs.
   *
   * A `creatorWawuId` filter DROPS the streams that have no creator
   * counterparty rather than returning them with an unmatched filter. A
   * verification tick and a shop order have nobody on the receiving end, so
   * "this creator's verification revenue" is not a question with an answer,
   * and answering it with every row on the platform would be worse than
   * answering it with none.
   */
  private ledgerBranches(
    query: AdminFinanceTransactionsQueryDto,
    period: { from: Date; to: Date },
  ): Prisma.Sql[] {
    const wanted = new Set<AdminFinanceStream>(
      query.stream && query.stream.length > 0
        ? query.stream
        : ADMIN_FINANCE_STREAMS,
    );
    const creator = query.creatorWawuId;
    const { from, to } = period;

    const branches: Prisma.Sql[] = [];

    // ── Purchase: content unlocks and tips, one table, two streams ──────────
    const purchaseStatus = Prisma.sql`CASE p."status"
      WHEN 'completed' THEN 'settled' WHEN 'failed' THEN 'failed' ELSE 'pending' END`;
    for (const [stream, type] of [
      ['content', 'content'],
      ['tips', 'tip'],
    ] as const) {
      if (!wanted.has(stream)) continue;
      branches.push(Prisma.sql`
        SELECT ${stream}::text AS "stream", p."id"::text AS "id",
               p."purchasedAt" AS "occurredAt",
               p."creatorWawuId"::text AS "creatorWawuId",
               p."buyerWawuId"::text AS "buyerWawuId",
               p."amount"::int AS "grossNaira",
               ROUND(p."commissionRate" * 10000)::int AS "commissionBps",
               p."status"::text AS "sourceStatus",
               ${purchaseStatus}::text AS "normStatus",
               p."flutterwaveTxRef"::text AS "txRef",
               p."flutterwaveTxId"::text AS "txId"
          FROM "Purchase" p
         WHERE p."type"::text = ${type}
           AND p."purchasedAt" >= ${from} AND p."purchasedAt" < ${to}
           ${creator ? Prisma.sql`AND p."creatorWawuId" = ${creator}` : Prisma.empty}
      `);
    }

    // ── DirectMessage: the row exists only because the charge verified ──────
    if (wanted.has('dm')) {
      branches.push(Prisma.sql`
        SELECT 'dm'::text AS "stream", d."id"::text AS "id",
               d."sentAt" AS "occurredAt",
               d."creatorWawuId"::text AS "creatorWawuId",
               d."senderWawuId"::text AS "buyerWawuId",
               d."amount"::int AS "grossNaira",
               ${Math.round(STANDARD_COMMISSION_RATE * 10_000)}::int AS "commissionBps",
               d."status"::text AS "sourceStatus",
               CASE d."status" WHEN 'refunded' THEN 'refunded' ELSE 'settled' END::text AS "normStatus",
               d."flutterwaveTxRef"::text AS "txRef",
               d."flutterwaveTxId"::text AS "txId"
          FROM "DirectMessage" d
         WHERE d."sentAt" >= ${from} AND d."sentAt" < ${to}
           ${creator ? Prisma.sql`AND d."creatorWawuId" = ${creator}` : Prisma.empty}
      `);
    }

    // ── CreditPurchase: the moment WAWU banks a pack ────────────────────────
    // Dropped under a creator filter: the pack is bought from WAWU, and which
    // host eventually earns from it is decided credit by credit at spend time
    // against the funding lot, not here.
    if (wanted.has('credits') && !creator) {
      branches.push(Prisma.sql`
        SELECT 'credits'::text AS "stream", c."id"::text AS "id",
               c."purchasedAt" AS "occurredAt",
               NULL::text AS "creatorWawuId",
               c."userWawuId"::text AS "buyerWawuId",
               c."amount"::int AS "grossNaira",
               ${Math.round(CREDITS_COMMISSION_RATE * 10_000)}::int AS "commissionBps",
               c."status"::text AS "sourceStatus",
               CASE c."status"
                 WHEN 'completed' THEN 'settled' WHEN 'failed' THEN 'failed'
                 ELSE 'pending' END::text AS "normStatus",
               c."flutterwaveTxRef"::text AS "txRef",
               NULL::text AS "txId"
          FROM "CreditPurchase" c
         WHERE c."purchasedAt" >= ${from} AND c."purchasedAt" < ${to}
      `);
    }

    // ── VerificationPurchase: paid to the platform, no counterparty ─────────
    if (wanted.has('verification') && !creator) {
      branches.push(Prisma.sql`
        SELECT 'verification'::text AS "stream", v."id"::text AS "id",
               v."createdAt" AS "occurredAt",
               NULL::text AS "creatorWawuId",
               v."wawuUserId"::text AS "buyerWawuId",
               v."priceNgn"::int AS "grossNaira",
               10000::int AS "commissionBps",
               v."status"::text AS "sourceStatus",
               CASE v."status"
                 WHEN 'completed' THEN 'settled' WHEN 'failed' THEN 'failed'
                 ELSE 'pending' END::text AS "normStatus",
               v."flutterwaveTxRef"::text AS "txRef",
               v."flutterwaveTxId"::text AS "txId"
          FROM "VerificationPurchase" v
         WHERE v."createdAt" >= ${from} AND v."createdAt" < ${to}
      `);
    }

    // ── EventOrder: the organiser is on Event, one join away ────────────────
    if (wanted.has('events')) {
      branches.push(Prisma.sql`
        SELECT 'events'::text AS "stream", o."id"::text AS "id",
               o."createdAt" AS "occurredAt",
               e."hostWawuId"::text AS "creatorWawuId",
               o."buyerWawuId"::text AS "buyerWawuId",
               o."amountNaira"::int AS "grossNaira",
               ROUND(o."commissionRate" * 10000)::int AS "commissionBps",
               o."status"::text AS "sourceStatus",
               CASE o."status"
                 WHEN 'paid' THEN 'settled' WHEN 'refunded' THEN 'refunded'
                 WHEN 'failed' THEN 'failed' ELSE 'pending' END::text AS "normStatus",
               o."flutterwaveTxRef"::text AS "txRef",
               o."flutterwaveTxId"::text AS "txId"
          FROM "EventOrder" o
          JOIN "Event" e ON e."id" = o."eventId"
         WHERE o."createdAt" >= ${from} AND o."createdAt" < ${to}
           ${creator ? Prisma.sql`AND e."hostWawuId" = ${creator}` : Prisma.empty}
      `);
    }

    // ── ShopOrder: WAWU's own catalogue, no seller ──────────────────────────
    if (wanted.has('shop') && !creator) {
      branches.push(Prisma.sql`
        SELECT 'shop'::text AS "stream", s."id"::text AS "id",
               s."createdAt" AS "occurredAt",
               NULL::text AS "creatorWawuId",
               s."buyerWawuId"::text AS "buyerWawuId",
               s."totalNaira"::int AS "grossNaira",
               10000::int AS "commissionBps",
               s."status"::text AS "sourceStatus",
               CASE s."status"
                 WHEN 'paid' THEN 'settled' WHEN 'refunded' THEN 'refunded'
                 WHEN 'cancelled' THEN 'cancelled' WHEN 'failed' THEN 'failed'
                 ELSE 'pending' END::text AS "normStatus",
               s."flutterwaveTxRef"::text AS "txRef",
               s."flutterwaveTxId"::text AS "txId"
          FROM "ShopOrder" s
         WHERE s."createdAt" >= ${from} AND s."createdAt" < ${to}
      `);
    }

    return branches;
  }

  /**
   * Handles for a page of rows, in one read.
   *
   * `UserProfile.handle` is the whole of the display name this backend holds:
   * names live in WAWU ID, on the token claim, and are never persisted here.
   * A row whose account has no profile keeps its wawuId and a null handle
   * rather than disappearing - an operator chasing an orphaned payment needs
   * to see it more than anybody.
   */
  private async resolveHandles(
    ids: Array<string | null>,
  ): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const profiles = await this.prisma.userProfile.findMany({
      where: { wawuUserId: { in: unique } },
      select: { wawuUserId: true, handle: true },
    });
    return new Map(profiles.map((p) => [p.wawuUserId, p.handle]));
  }
}

/** Folds one group's gross into a stream's running total, splitting it at that group's own rate. */
function addInto(
  target: AdminFinanceMoneyView,
  grossKobo: number,
  commissionRate: number,
  count: number,
): void {
  const { wawuShareKobo, creatorShareKobo } = splitKobo(
    grossKobo,
    commissionRate,
  );
  target.grossKobo += grossKobo;
  target.wawuShareKobo += wawuShareKobo;
  target.creatorShareKobo += creatorShareKobo;
  target.transactionCount += count;
}

function party(
  wawuId: string | null,
  handles: Map<string, string | null>,
): AdminFinancePartyView | null {
  if (!wawuId) return null;
  return { wawuId, handle: handles.get(wawuId) ?? null };
}

/**
 * The window a request actually covers.
 *
 * One bound given and the other omitted is answered rather than refused: an
 * operator asking "everything since 1 August" gets everything since 1 August,
 * and the resolved `to` comes back on the response so the screen can say so.
 * The open end is the epoch on one side and a century out on the other, which
 * is simply "no bound" expressed as a date the SQL can compare against.
 */
export function resolvePeriod(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): { from: Date; to: Date; isDefaultPeriod: boolean } {
  if (!from && !to) {
    return { ...currentCalendarMonth(now), isDefaultPeriod: true };
  }
  return {
    from: from ? new Date(from) : new Date(0),
    to: to ? new Date(to) : new Date(Date.UTC(2999, 0, 1)),
    isDefaultPeriod: false,
  };
}

export function toPeriodView(period: {
  from: Date;
  to: Date;
  isDefaultPeriod: boolean;
}): AdminFinancePeriodView {
  return {
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    isDefaultPeriod: period.isDefaultPeriod,
  };
}
