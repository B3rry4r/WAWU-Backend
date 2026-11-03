import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { packById } from '../../plans/purchases/points-pack-rules';
import {
  PLANS_CONFIG,
  priceIn,
  tierById,
  type PlansConfig,
} from '../../plans/plans-config';
import type {
  AdminMoneyBasisView,
  AdminMoneyForeignChargeView,
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
  'Each sale is priced once, in this order: what the store charged in naira, before its cut; else the list price recorded at purchase; else today’s list price. Charges in other currencies are listed by currency and never converted. Sales no basis can price are counted in unpricedCount. Not what the store paid out.';

const BASIS_LABEL: Record<string, string> = {
  store_charge: 'As charged by the store, before its cut',
  recorded_list_price: 'List price recorded at purchase',
  todays_list_price: 'Today’s list price',
  unpriced: 'No price in our records',
};
const BASIS_ORDER = [
  'store_charge',
  'recorded_list_price',
  'todays_list_price',
  'unpriced',
];

/** Money taken by the store and later given back (refunded) or taken back (revoked). */
const STORE_GIVEN_BACK = ['refunded', 'revoked'];

const REVENUE_NOTE =
  'Each stream is read from its own table on its own rail, so the streams are not added into one total here. Gross is the money taken; refundedKobo is refunded to payers; keptKobo is gross less refunded, and the 85/15 shares are worked on the money kept. Store sales are shown before the store’s cut. A store sale refunded or revoked later is shown in the window it was bought in, as refunded there, not in the window of the refund.';

type Bases = Map<string, { count: number; grossKobo: number }>;

function addBasis(m: Bases, basis: string, kobo: number): void {
  const e = m.get(basis) ?? { count: 0, grossKobo: 0 };
  e.count += 1;
  e.grossKobo += kobo;
  m.set(basis, e);
}

function basesView(m: Bases): AdminMoneyBasisView[] {
  return BASIS_ORDER.filter((b) => m.has(b)).map((b) => ({
    basis: b,
    label: BASIS_LABEL[b],
    count: m.get(b)!.count,
    grossKobo: m.get(b)!.grossKobo,
  }));
}

interface KindAcc {
  count: number;
  gross: number;
  unpriced: number;
  bases: Bases;
}

/** The sale's grant as the product stored it: only the ids the live plan prices. */
interface ProductGrants {
  tierId?: string | null;
  packId?: string | null;
}

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

const HELD_KINDS = ['paid_dm', 'event_ticket', 'bill', 'school_fee'];

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
    @Inject(PLANS_CONFIG) private readonly plans: PlansConfig,
  ) {}

  /** Today's list price of what the product sells, from the live plan; null when the plan does not price it. */
  private todaysListKobo(kind: string, grants: unknown): number | null {
    const g = (grants ?? {}) as ProductGrants;
    if (kind === 'tier') {
      const t = g.tierId ? tierById(this.plans, g.tierId) : null;
      return t ? priceIn(t.price, 'NGN') : null;
    }
    if (kind === 'points') {
      const k = g.packId ? packById(this.plans, g.packId) : null;
      return k ? priceIn(k.price, 'NGN') : null;
    }
    if (kind === 'extra_products') {
      return priceIn(this.plans.extraProducts.price, 'NGN');
    }
    return null;
  }

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
      note: REVENUE_NOTE,
    };
  }

  private async storeStreams(
    from: Date,
    to: Date,
  ): Promise<AdminMoneyStreamView[]> {
    const where: Prisma.StorePurchaseWhereInput = {
      status: { in: ['granted', 'refunded', 'revoked'] },
      purchasedAt: { gte: from, lt: to },
    };
    // One pass, in pages, pricing each sale on the first basis that can.
    const acc = {
      ios: new Map<string, KindAcc>(),
      android: new Map<string, KindAcc>(),
    };
    const refunded = { ios: 0, android: 0 };
    const refundedCount = { ios: 0, android: 0 };
    const foreign = {
      ios: new Map<string, { count: number; amountMinor: number }>(),
      android: new Map<string, { count: number; amountMinor: number }>(),
    };
    let after: string | undefined;
    for (;;) {
      const rows = await this.prisma.storePurchase.findMany({
        where,
        orderBy: { id: 'asc' },
        take: 2000,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        select: {
          id: true,
          platform: true,
          kind: true,
          status: true,
          priceMicros: true,
          currency: true,
          referenceKobo: true,
          product: { select: { grants: true } },
        },
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        const cur = r.currency?.toUpperCase() ?? null;
        let basis = 'unpriced';
        let kobo = 0;
        if (cur === 'NGN' && r.priceMicros !== null) {
          basis = 'store_charge';
          kobo = Number(r.priceMicros / 10_000n);
        } else if (r.referenceKobo !== null) {
          basis = 'recorded_list_price';
          kobo = r.referenceKobo;
        } else {
          const today = this.todaysListKobo(r.kind, r.product.grants);
          if (today !== null) {
            basis = 'todays_list_price';
            kobo = today;
          }
        }
        if (cur !== null && cur !== 'NGN' && r.priceMicros !== null) {
          const f = foreign[r.platform].get(cur) ?? {
            count: 0,
            amountMinor: 0,
          };
          f.count += 1;
          f.amountMinor += Number(r.priceMicros / 10_000n);
          foreign[r.platform].set(cur, f);
        }
        const k = acc[r.platform].get(r.kind) ?? {
          count: 0,
          gross: 0,
          unpriced: 0,
          bases: new Map(),
        };
        k.count += 1;
        k.gross += kobo;
        if (basis === 'unpriced') k.unpriced += 1;
        addBasis(k.bases, basis, kobo);
        acc[r.platform].set(r.kind, k);
        if (STORE_GIVEN_BACK.includes(r.status)) {
          refunded[r.platform] += kobo;
          refundedCount[r.platform] += 1;
        }
      }
      after = rows[rows.length - 1].id;
      if (rows.length < 2000) break;
    }
    const out: AdminMoneyStreamView[] = [];
    for (const platform of ['ios', 'android'] as const) {
      const total: Bases = new Map();
      const breakdown: AdminMoneyBreakdownView[] = [...acc[platform].entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, k]) => {
          for (const [b, v] of k.bases) {
            const t = total.get(b) ?? { count: 0, grossKobo: 0 };
            t.count += v.count;
            t.grossKobo += v.grossKobo;
            total.set(b, t);
          }
          return {
            key: kind,
            label: STORE_KIND_LABEL[kind] ?? kind,
            count: k.count,
            grossKobo: k.gross,
            unpricedCount: k.unpriced,
            bases: basesView(k.bases),
          };
        });
      const gross = breakdown.reduce((a, b) => a + b.grossKobo, 0);
      const foreignCharges: AdminMoneyForeignChargeView[] = [
        ...foreign[platform].entries(),
      ]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, v]) => ({ currency, ...v }));
      out.push({
        key: platform === 'ios' ? 'store_apple' : 'store_google',
        label: platform === 'ios' ? 'App Store sales' : 'Google Play sales',
        rail: platform === 'ios' ? 'Apple' : 'Google',
        source: 'StorePurchase',
        statuses: ['granted', ...STORE_GIVEN_BACK],
        count: breakdown.reduce((a, b) => a + b.count, 0),
        grossKobo: gross,
        unpricedCount: breakdown.reduce((a, b) => a + b.unpricedCount, 0),
        grossBasis: STORE_BASIS,
        wawuKobo: null,
        creatorsKobo: null,
        refundedKobo: refunded[platform],
        keptKobo: gross - refunded[platform],
        bases: basesView(total),
        foreignCharges,
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
      keptKobo: breakdown.reduce((a, b) => a + b.grossKobo, 0),
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
        _sum: {
          refundedKobo: true,
          payeeShareKobo: true,
          wawuShareKobo: true,
        },
      }),
    ]);
    const refundOf = new Map(refunds.map((r) => [r.kind, r]));
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
      // A refunded hold gave the whole price back, so its shares are not kept.
      const back = refundOf.get(kind);
      const refunded = big(back?._sum.refundedKobo);
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
          'The price paid from the wallet, before the provider’s own charge on it. Gross is the money taken; the shares are worked on the money kept.',
        wawuKobo: big(g?._sum.wawuShareKobo) - big(back?._sum.wawuShareKobo),
        creatorsKobo:
          big(g?._sum.payeeShareKobo) - big(back?._sum.payeeShareKobo),
        refundedKobo: HELD_KINDS.includes(kind) ? refunded : null,
        keptKobo: gross - refunded,
      };
    });
  }
}
