import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type {
  AdminMoneyBreakdownView,
  AdminMoneyRevenueQueryDto,
  AdminMoneyRevenueView,
  AdminMoneyStreamView,
} from './admin-money.dto';

/** The one split (R-5): creators 85, WAWU 15. */
const CREATORS_PERCENT = 85;
const WAWU_PERCENT = 15;

const STORE_KIND_LABEL: Record<string, string> = {
  points: 'Points packs',
  credits: 'WAWU Credits packs',
  tier: 'Tiers',
  pass: 'Community passes',
  extra_products: 'Extra uploads',
  buy: 'Price ladder (wawu.buy.*)',
};

const STORE_BASIS =
  'The list price before the store’s cut, summed. Not what the store paid out. Tiers and points packs carry no list price in our records, so they are counted and not priced.';

/** The wallet-paid kinds the owner reads by name; any other kind keeps its own name. */
const WALLET_KIND_LABEL: Record<string, string> = {
  content_unlock: 'Content unlocks',
  tip: 'Tips',
  paid_dm: 'Paid DMs',
  event_ticket: 'Event tickets',
  bill: 'Bills',
  credit_pack: 'WAWU Credits',
  verification: 'Verification ticks',
  legal_fee: 'Legal fees',
  school_fee: 'School fees',
  tier: 'Tiers',
  tier_bump: 'Tier upgrades',
  points_pack: 'Points packs',
  extra_products: 'Extra uploads',
  points_shortfall: 'Points top-ups',
  community_pass: 'Community passes',
};
/** The order streams are listed in: the six the owner asked for first. */
const WALLET_KIND_ORDER = [
  'content_unlock',
  'tip',
  'paid_dm',
  'event_ticket',
  'bill',
  'credit_pack',
];

const JOIN_TIER_LABEL: Record<string, string> = {
  verify: 'Verify',
  plus: 'Plus',
  founding: 'Founding',
};

/** The current calendar month in UTC: the window when neither bound is given. */
function resolveWindow(
  q: AdminMoneyRevenueQueryDto,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const nextMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const from = q.from ? new Date(q.from) : monthStart;
  const to = q.to ? new Date(q.to) : q.from ? now : nextMonth;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('from and to have to be ISO 8601 dates.');
  }
  if (to.getTime() <= from.getTime()) {
    throw new BadRequestException(
      '`to` has to be after `from`. The window is [from, to): inclusive at the start, exclusive at the end.',
    );
  }
  return { from, to };
}

function big(v: bigint | null | undefined): number {
  return safeKoboNumber(v ?? 0n);
}

interface JoinRow {
  tier: string | null;
  n: number;
  gross: bigint;
}

/**
 * The app's money by stream (DASH-B-HUB). Every stream prints its source
 * table, the statuses that count, and the rail that took the money. Gross is
 * what the row says was charged (store sales: the list price before the
 * store's cut, never a net guess). The 85/15 split is read from each wallet
 * payment's own stored shares (R-5), never recomputed. No Shop stream (R-2).
 * Rows are those of the provider the server runs. Reads only.
 */
@Injectable()
export class AdminMoneyRevenueService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  async revenue(q: AdminMoneyRevenueQueryDto): Promise<AdminMoneyRevenueView> {
    const { from, to } = resolveWindow(q);
    const [store, join, wallet] = await Promise.all([
      this.storeStreams(from, to),
      this.joinStream(from, to),
      this.walletStreams(from, to),
    ]);
    return {
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        window: '[from, to): inclusive at the start, exclusive at the end',
      },
      split: { creatorsPercent: CREATORS_PERCENT, wawuPercent: WAWU_PERCENT },
      streams: [...wallet, ...store, join],
      note: 'Each stream is read from its own table on its own rail, so the streams are not added into one total here. Store sales are shown before the store’s cut.',
    };
  }

  private async storeStreams(
    from: Date,
    to: Date,
  ): Promise<AdminMoneyStreamView[]> {
    const groups = await this.prisma.storePurchase.groupBy({
      by: ['platform', 'kind'],
      where: { status: 'granted', purchasedAt: { gte: from, lt: to } },
      _count: { _all: true, referenceKobo: true },
      _sum: { referenceKobo: true },
    });
    const out: AdminMoneyStreamView[] = [];
    for (const platform of ['ios', 'android'] as const) {
      const rows = groups.filter((g) => g.platform === platform);
      const breakdown: AdminMoneyBreakdownView[] = rows.map((g) => ({
        key: g.kind,
        label: STORE_KIND_LABEL[g.kind] ?? g.kind,
        count: g._count._all,
        grossKobo: g._sum.referenceKobo ?? 0,
        unpricedCount: g._count._all - g._count.referenceKobo,
      }));
      out.push({
        key: platform === 'ios' ? 'store_apple' : 'store_google',
        label: platform === 'ios' ? 'App Store sales' : 'Google Play sales',
        rail: platform === 'ios' ? 'Apple' : 'Google',
        source: 'StorePurchase',
        statuses: ['granted'],
        count: breakdown.reduce((a, b) => a + b.count, 0),
        grossKobo: breakdown.reduce((a, b) => a + b.grossKobo, 0),
        unpricedCount: breakdown.reduce((a, b) => a + b.unpricedCount, 0),
        grossBasis: STORE_BASIS,
        wawuKobo: null,
        creatorsKobo: null,
        refundedKobo: null,
        breakdown,
      });
    }
    return out;
  }

  private async joinStream(
    from: Date,
    to: Date,
  ): Promise<AdminMoneyStreamView> {
    // A paid row's own figure: what Flutterwave confirmed, else the price it was made at.
    const rows = await this.prisma.$queryRaw<JoinRow[]>(Prisma.sql`
      SELECT "tier", COUNT(*)::int AS n,
             COALESCE(SUM(COALESCE("paidKobo", "amountKobo")), 0)::bigint AS gross
      FROM "WaitlistRegistration"
      WHERE "status" = 'paid'
        AND COALESCE("paidAt", "updatedAt") >= ${from}
        AND COALESCE("paidAt", "updatedAt") < ${to}
      GROUP BY "tier"
      ORDER BY "tier" NULLS FIRST`);
    const breakdown: AdminMoneyBreakdownView[] = rows.map((r) => ({
      key: r.tier ?? 'untiered',
      label: r.tier
        ? (JOIN_TIER_LABEL[r.tier] ?? r.tier)
        : 'Before tiers were sold',
      count: r.n,
      grossKobo: big(r.gross),
      unpricedCount: 0,
    }));
    return {
      key: 'join_web',
      label: '/join web payments',
      rail: 'Flutterwave',
      source: 'WaitlistRegistration',
      statuses: ['paid'],
      count: breakdown.reduce((a, b) => a + b.count, 0),
      grossKobo: breakdown.reduce((a, b) => a + b.grossKobo, 0),
      unpricedCount: 0,
      grossBasis:
        'What Flutterwave confirmed on the website’s /join page, by tier. The only money Flutterwave still takes.',
      wawuKobo: null,
      creatorsKobo: null,
      refundedKobo: null,
      breakdown,
    };
  }

  private async walletStreams(
    from: Date,
    to: Date,
  ): Promise<AdminMoneyStreamView[]> {
    const where: Prisma.WalletPaymentWhereInput = {
      status: 'completed',
      provider: this.provider.name,
      completedAt: { gte: from, lt: to },
    };
    const [groups, refunds] = await Promise.all([
      this.prisma.walletPayment.groupBy({
        by: ['kind'],
        where,
        _count: { _all: true },
        _sum: { priceKobo: true, payeeShareKobo: true, wawuShareKobo: true },
      }),
      this.prisma.walletHold.groupBy({
        by: ['kind'],
        where: { status: 'refunded', payment: where },
        _sum: { refundedKobo: true },
      }),
    ]);
    const refundOf = new Map(
      refunds.map((r) => [r.kind, big(r._sum.refundedKobo)]),
    );
    const rank = (k: string) => {
      const i = WALLET_KIND_ORDER.indexOf(k);
      return i === -1 ? WALLET_KIND_ORDER.length : i;
    };
    const byKind = new Map(groups.map((g) => [g.kind, g]));
    // The six streams are always listed, empty or not; any other kind with money appears after them.
    const kinds = [
      ...new Set([...WALLET_KIND_ORDER, ...groups.map((g) => g.kind)]),
    ].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return kinds.map((kind) => {
      const g = byKind.get(kind);
      const gross = big(g?._sum.priceKobo);
      const payee = big(g?._sum.payeeShareKobo);
      return {
        key: `wallet_${kind}`,
        label: WALLET_KIND_LABEL[kind] ?? kind,
        rail: this.provider.label,
        source: 'WalletPayment',
        statuses: ['completed'],
        count: g?._count._all ?? 0,
        grossKobo: gross,
        unpricedCount: 0,
        grossBasis:
          'The price paid from the wallet, before the provider’s own charge on it. WAWU’s share and the creators’ share are the ones stored on each payment.',
        wawuKobo: big(g?._sum.wawuShareKobo),
        creatorsKobo: payee,
        refundedKobo: [
          'paid_dm',
          'event_ticket',
          'bill',
          'school_fee',
        ].includes(kind)
          ? (refundOf.get(kind) ?? 0)
          : null,
      };
    });
  }
}
