import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DmStatus,
  PurchaseType,
  TransactionStatus,
} from '../../generated/prisma/enums';
import type {
  CreatorEarningsRecentSale,
  CreatorEarningsResponse,
  CreatorEarningsStreamBreakdownEntry,
} from '../common/types';

/**
 * Standard/Pro commission rates — mirrors src/purchase/purchase.service.ts
 * and src/content-piece/content-piece.service.ts exactly (conventions.md §
 * Identity & format canon: "never invent a different split"). Duplicated
 * locally per this build's per-resource scope rule (task brief), same as
 * those two services duplicate it from each other rather than sharing a
 * constants module that doesn't exist yet.
 */
const STANDARD_COMMISSION_RATE = 0.15;
const PRO_COMMISSION_RATE = 0.1;

/**
 * WAWU Credits are 90/10 for EVERY creator on every tier (docs/01_SPEC.md
 * §1 row 4; §1 row 8 scopes the Pro upgrade to "streams 1, 2, 3, 5, 6",
 * which pointedly excludes credits, and §3 calls 90% "deliberately a better
 * split than every other stream"). So the credits stream deliberately does
 * NOT go through resolveCommissionRate() below — a Basic host and a Pro
 * host earn the same 90 on a spent credit.
 *
 * The rate is applied at SPEND time, not here:
 * src/credit-spend/credit-spend.service.ts snapshots each spend's host share
 * onto a CreditSpendEarning row, the way Purchase snapshots its own
 * commissionRate, because the naira a credit is worth depends on which
 * purchase lot funded it and that is not recoverable after the fact. This
 * service sums those snapshots.
 */

/** Last-N cap for the recentSales feed — earnings is a summary view, not a paginated ledger (registry note: "flat aggregate ... not a running ledger balance"). */
const RECENT_SALES_LIMIT = 10;

/** Internal shape while sorting — carries a real Date for comparison; `occurredAt` is serialized to ISO only in the final map. */
interface SaleRow {
  id: string;
  source: CreatorEarningsRecentSale['source'];
  /** Naira, except `community_credits` where it is a credit count. */
  amount: number;
  /** Always naira. */
  earningsNaira: number;
  occurredAt: Date;
}

/**
 * CreatorEarnings (registry.json) has NO Prisma model of its own — every
 * field here is a live read across Purchase + DirectMessage + CreditSpend
 * (docs/02_TECHNICAL_CONTEXT.md §3.7: "flat aggregate query ... not a
 * running ledger balance"). CreatorSubscription is read ONLY to resolve the
 * caller's own commission-rate tier — a creator's own subscription payment
 * is money THEY pay WAWU, not an earning, so it never appears in
 * streamBreakdown or recentSales (see resolveCommissionRate()'s doc
 * comment and the final build report for the full reasoning).
 *
 * CREDITS, 2026-08-22 — the defect this resource used to embody.
 *
 * This service previously reported `community_credits` as a raw credit
 * COUNT and excluded it from `total`, `payable` and `held`, on the grounds
 * that CreditSpend carried no money and there was no way to know which
 * pack-price funded a given credit. The reasoning about the data was right;
 * the conclusion was not. The product SELLS that 90% on six screens
 * (docs/01_SPEC.md §1 row 4), so "there is no data" was a missing feature,
 * not a licence to pay zero. The data now exists: CreditSpendEarning
 * snapshots the host's share at spend time against the actual purchase lot
 * that funded the credit (src/credit-spend/credit-spend.service.ts §"THE
 * COST-BASIS MODEL").
 *
 * What changed here, and what deliberately did NOT:
 *   - `payable` and `total` now include the host's credit earnings. A spent
 *     credit is money WAWU already banked and the host already delivered
 *     the community for, so it is payable, never held (unlike a DM, which
 *     is held until the creator responds).
 *   - `streamBreakdown[community_credits].amount` STAYS a credit COUNT, and
 *     so does the `amount` on a `community_credits` recentSale. The shipped
 *     app renders both as `${amount} credits` (WAWU-Web
 *     src/lib/earnings-display.ts); flipping them to naira would make a
 *     live screen print a naira figure with the word "credits" after it,
 *     and CLAUDE.md forbids a credit count rendering as naira anywhere.
 *   - The money is carried on a NEW, additive `earningsNaira` field present
 *     on every breakdown entry and every recent sale. For the naira streams
 *     it equals `amount`; for credits it is the 90% share.
 *
 * Nothing here gives anybody a spendable balance: this is the same kind of
 * read-time earnings figure the other four streams already produce. There
 * is still no wallet, no cash-out, and a member's credit balance
 * (GET /credits) is untouched and still a count.
 */
@Injectable()
export class CreatorEarningsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mirrors Purchase/ContentPiece's own resolveCommissionRate() exactly: one flat rate for every creator. */
  private resolveCommissionRate(): number {
    return STANDARD_COMMISSION_RATE;
  }

  async getForCreator(creatorWawuId: string): Promise<CreatorEarningsResponse> {
    const purchaseWhere = {
      creatorWawuId,
      status: TransactionStatus.completed,
      type: { in: [PurchaseType.content, PurchaseType.tip] },
    };
    const dmWhere = {
      creatorWawuId,
      status: { in: [DmStatus.responded, DmStatus.awaiting_response] },
    };

    const [
      commissionRate,
      purchaseTotals,
      recentPurchases,
      dmTotals,
      recentDms,
      creditTotals,
      creditEarningTotals,
      recentCreditSpends,
    ] = await Promise.all([
      this.resolveCommissionRate(),
      // Totals are summed IN POSTGRES, grouped by the two dimensions the
      // net-of-commission maths needs (type, and the per-row snapshotted
      // rate). This used to be a findMany() of every Purchase/DirectMessage/
      // CreditSpend row the creator ever had, reduced in JS — a successful
      // creator's earnings screen would eventually OOM the process.
      this.prisma.purchase.groupBy({
        by: ['type', 'commissionRate'],
        where: purchaseWhere,
        _sum: { amount: true },
      }),
      this.prisma.purchase.findMany({
        where: purchaseWhere,
        orderBy: { purchasedAt: 'desc' },
        take: RECENT_SALES_LIMIT,
        select: {
          id: true,
          type: true,
          amount: true,
          commissionRate: true,
          purchasedAt: true,
        },
      }),
      this.prisma.directMessage.groupBy({
        by: ['status'],
        where: dmWhere,
        _sum: { amount: true },
      }),
      this.prisma.directMessage.findMany({
        where: dmWhere,
        orderBy: { sentAt: 'desc' },
        take: RECENT_SALES_LIMIT,
        select: { id: true, amount: true, sentAt: true },
      }),
      // Credits, COUNT: still read from CreditSpend itself, not from the
      // earnings table. A spend that predates the earnings ledger (or that
      // was trial-covered) has no earning row, and it must still show up in
      // the host's activity count — the count is volume, the naira is money,
      // and the two are deliberately sourced separately.
      this.prisma.creditSpend.aggregate({
        where: { creatorWawuId },
        _sum: { creditsSpent: true },
      }),
      // Credits, MONEY: a sum of shares frozen at spend time against the
      // real purchase lot that funded each credit. Never a live
      // re-derivation — see the class doc comment.
      this.prisma.creditSpendEarning.aggregate({
        where: { creatorWawuId },
        _sum: { hostShareKobo: true },
      }),
      this.prisma.creditSpend.findMany({
        where: { creatorWawuId },
        orderBy: { spentAt: 'desc' },
        take: RECENT_SALES_LIMIT,
        select: {
          id: true,
          creditsSpent: true,
          spentAt: true,
          earning: { select: { hostShareKobo: true } },
        },
      }),
    ]);

    // ---- Purchase: content + tips, always "payable" (Purchase has no
    // held/escrow state of its own — `status: completed` already means the
    // charge cleared). Each row uses ITS OWN snapshotted commissionRate
    // (locked in at transaction time), not the caller's current rate —
    // which is exactly why the group-by carries `commissionRate` as a key.
    // ----
    let contentTotal = 0;
    let tipsTotal = 0;

    for (const group of purchaseTotals) {
      const gross = group._sum.amount ?? 0;
      const net = gross * (1 - Number(group.commissionRate));
      if (group.type === PurchaseType.content) contentTotal += net;
      else tipsTotal += net;
    }

    const purchaseSales: SaleRow[] = recentPurchases.map((p) => {
      const net = round2(p.amount * (1 - Number(p.commissionRate)));
      return {
        id: p.id,
        source: p.type === PurchaseType.content ? 'content' : 'tip',
        amount: net,
        // Naira stream: `amount` already IS the earning.
        earningsNaira: net,
        occurredAt: p.purchasedAt,
      };
    });

    // ---- DirectMessage: `responded` rows are payable (payout released on
    // respond, docs/02_TECHNICAL_CONTEXT.md §3.4); `awaiting_response` rows
    // are held (payout gated on the creator's response, or refunded by the
    // deadline-sweep cron — refunded rows are excluded above since that
    // money returns to the sender, never a creator earning). DirectMessage
    // has no stored commissionRate (unlike Purchase), so the CURRENT rate
    // is applied at read time — this is a judgment call: there is no
    // snapshot to fall back on, and "flat aggregate, not a running ledger"
    // reads as sanctioning a live recompute here. ----
    let dmPayable = 0;
    let dmHeld = 0;

    for (const group of dmTotals) {
      const net = (group._sum.amount ?? 0) * (1 - commissionRate);
      if (group.status === DmStatus.responded) {
        dmPayable += net;
      } else if (group.status === DmStatus.awaiting_response) {
        dmHeld += net;
      }
      // `refunded` contributes NOTHING, to either figure. It used to fall
      // into `held` via a bare else, so an expired DM sat in the creator's
      // balance as money they were still owed — forever, since nothing ever
      // moved it out. The payer is getting that money back; it was never the
      // creator's to hold. It is also dropped from the `dm` stream total
      // below for the same reason.
    }

    const dmSales: SaleRow[] = recentDms.map((dm) => {
      const net = round2(dm.amount * (1 - commissionRate));
      return {
        id: dm.id,
        source: 'dm' as const,
        amount: net,
        earningsNaira: net,
        occurredAt: dm.sentAt,
      };
    });

    // ---- Credits: two figures, never mixed. `creditsSpentTotal` is the
    // COUNT the app renders as "N credits"; `creditsNairaTotal` is the
    // host's 90% share in naira, which feeds `payable`/`total` and the new
    // `earningsNaira`. Always payable, never held: the member's money
    // cleared at purchase and the message was delivered instantly, so there
    // is no equivalent of DM's awaiting_response escrow. ----
    const creditsSpentTotal = creditTotals._sum.creditsSpent ?? 0;
    const creditsNairaTotal = koboToNaira(
      creditEarningTotals._sum.hostShareKobo ?? 0,
    );
    const creditSales: SaleRow[] = recentCreditSpends.map((c) => ({
      id: c.id,
      source: 'community_credits' as const,
      amount: c.creditsSpent,
      // No earning row = a trial-covered or otherwise unfunded credit; the
      // host earned ₦0 on it because WAWU banked ₦0 for it.
      earningsNaira: koboToNaira(c.earning?.hostShareKobo ?? 0),
      occurredAt: c.spentAt,
    }));

    const payable = round2(
      contentTotal + tipsTotal + dmPayable + creditsNairaTotal,
    );
    const held = round2(dmHeld);
    const total = round2(payable + held);

    // Each source contributed at most RECENT_SALES_LIMIT rows, already in
    // newest-first order, so the true global top-N is guaranteed to be
    // inside this <=3N merge.
    const recentSales: CreatorEarningsRecentSale[] = [
      ...purchaseSales,
      ...dmSales,
      ...creditSales,
    ]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, RECENT_SALES_LIMIT)
      .map(({ id, source, amount, earningsNaira, occurredAt }) => ({
        id,
        source,
        amount,
        earningsNaira,
        occurredAt: occurredAt.toISOString(),
      }));

    const streamBreakdown: CreatorEarningsStreamBreakdownEntry[] = [
      {
        stream: 'content',
        amount: round2(contentTotal),
        earningsNaira: round2(contentTotal),
      },
      {
        stream: 'tips',
        amount: round2(tipsTotal),
        earningsNaira: round2(tipsTotal),
      },
      {
        // Payable + held, and refunds are in neither — a refunded DM is not
        // earnings, so counting it here would make the stream breakdown
        // disagree with the totals directly above it.
        stream: 'dm',
        amount: round2(dmPayable + dmHeld),
        earningsNaira: round2(dmPayable + dmHeld),
      },
      {
        // `amount` is deliberately a credit COUNT — the live app prints it
        // as "N credits". The 90% the spec promises is in `earningsNaira`.
        stream: 'community_credits',
        amount: creditsSpentTotal,
        earningsNaira: creditsNairaTotal,
      },
    ];

    return { total, payable, held, recentSales, streamBreakdown };
  }
}

/** Round to kobo (2dp) — amounts are integer-naira at the row level but commission math can produce fractional kobo. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Credit earnings are stored in integer kobo (exact by construction — see
 * CreditSpendService's largest-remainder allocation) and reported in naira,
 * like every other figure on this response.
 */
function koboToNaira(kobo: number): number {
  return round2(kobo / 100);
}
