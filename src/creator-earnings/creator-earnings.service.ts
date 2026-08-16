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
 * NOTE on WAWU Credits' flat 90/10 split (docs/01_SPEC.md §"Revenue model"
 * row 4, confirmed again by src/credit-spend/credit-spend.service.ts's own
 * doc comment: "the community host's 90% share") — this rate is NOT
 * applied anywhere below. It would only matter if `community_credits` were
 * converted to a naira figure, which this service deliberately does not do
 * (see the class-level doc comment's CreditSpend judgment call). Recorded
 * here so the next engineer who wires a real per-credit price doesn't have
 * to re-derive it.
 */

/** Last-N cap for the recentSales feed — earnings is a summary view, not a paginated ledger (registry note: "flat aggregate ... not a running ledger balance"). */
const RECENT_SALES_LIMIT = 10;

/** Internal shape while sorting — carries a real Date for comparison; `occurredAt` is serialized to ISO only in the final map. */
interface SaleRow {
  id: string;
  source: CreatorEarningsRecentSale['source'];
  amount: number;
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
 * JUDGMENT (biggest call in this resource, flagged loudly per task brief):
 * WAWU Credits render as a COUNT everywhere in this product, never a naira
 * value, never cashable (CLAUDE.md non-negotiable, capitalized, "Ever.").
 * CreditSpend has no amount field and no link back to which pack-price a
 * spent credit was bought at — there are three different per-credit prices
 * across the starter/popular/pro packs (₦10 / ₦8.33 / ₦6.67), and no data
 * to attribute a specific spend to one of them. Rather than invent a
 * blended conversion rate nowhere documented in the contract, this service
 * keeps `community_credits` as a raw credit COUNT in both `streamBreakdown`
 * and `recentSales`, and excludes it entirely from `total` / `payable` /
 * `held` (which are strictly naira sums per CreatorEarningsSummary's own
 * doc comment). See final build report.
 */
@Injectable()
export class CreatorEarningsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Snapshotted-at-read-time rate — mirrors Purchase/ContentPiece's own resolveCommissionRate() exactly (same CreatorState fields, same fallback). */
  private async resolveCommissionRate(creatorWawuId: string): Promise<number> {
    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { tier: true, subscriptionPaid: true },
    });
    if (
      creatorState &&
      creatorState.tier === 'pro' &&
      creatorState.subscriptionPaid
    ) {
      return PRO_COMMISSION_RATE;
    }
    return STANDARD_COMMISSION_RATE;
  }

  async getForCreator(creatorWawuId: string): Promise<CreatorEarningsResponse> {
    const [commissionRate, purchases, directMessages, creditSpends] =
      await Promise.all([
        this.resolveCommissionRate(creatorWawuId),
        this.prisma.purchase.findMany({
          where: {
            creatorWawuId,
            status: TransactionStatus.completed,
            type: { in: [PurchaseType.content, PurchaseType.tip] },
          },
          orderBy: { purchasedAt: 'desc' },
        }),
        this.prisma.directMessage.findMany({
          where: {
            creatorWawuId,
            status: { in: [DmStatus.responded, DmStatus.awaiting_response] },
          },
          orderBy: { sentAt: 'desc' },
        }),
        this.prisma.creditSpend.findMany({
          where: { creatorWawuId },
          orderBy: { spentAt: 'desc' },
        }),
      ]);

    // ---- Purchase: content + tips, always "payable" (Purchase has no
    // held/escrow state of its own — `status: completed` already means the
    // charge cleared). Each row uses ITS OWN snapshotted commissionRate
    // (locked in at transaction time), not the caller's current rate. ----
    let contentTotal = 0;
    let tipsTotal = 0;
    const purchaseSales: SaleRow[] = [];

    for (const p of purchases) {
      const net = p.amount * (1 - Number(p.commissionRate));
      if (p.type === PurchaseType.content) contentTotal += net;
      else tipsTotal += net;

      purchaseSales.push({
        id: p.id,
        source: p.type === PurchaseType.content ? 'content' : 'tip',
        amount: round2(net),
        occurredAt: p.purchasedAt,
      });
    }

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
    const dmSales: SaleRow[] = [];

    for (const dm of directMessages) {
      const net = dm.amount * (1 - commissionRate);
      if (dm.status === DmStatus.responded) {
        dmPayable += net;
      } else {
        dmHeld += net;
      }
      dmSales.push({
        id: dm.id,
        source: 'dm',
        amount: round2(net),
        occurredAt: dm.sentAt,
      });
    }

    // ---- CreditSpend: raw credit COUNT, never converted to naira — see
    // class-level doc comment. Always "payable" in the sense that a spent
    // credit is not held/escrowed anywhere in the contract (no equivalent
    // of DM's awaiting_response state exists on CreditSpend), but it is
    // NOT added into the naira `payable` figure — count and naira must
    // never be summed together. ----
    const creditsSpentTotal = creditSpends.reduce(
      (sum, c) => sum + c.creditsSpent,
      0,
    );
    const creditSales: SaleRow[] = creditSpends.map((c) => ({
      id: c.id,
      source: 'community_credits',
      amount: c.creditsSpent,
      occurredAt: c.spentAt,
    }));

    const payable = round2(contentTotal + tipsTotal + dmPayable);
    const held = round2(dmHeld);
    const total = round2(payable + held);

    const recentSales: CreatorEarningsRecentSale[] = [
      ...purchaseSales,
      ...dmSales,
      ...creditSales,
    ]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, RECENT_SALES_LIMIT)
      .map(({ id, source, amount, occurredAt }) => ({
        id,
        source,
        amount,
        occurredAt: occurredAt.toISOString(),
      }));

    const streamBreakdown: CreatorEarningsStreamBreakdownEntry[] = [
      { stream: 'content', amount: round2(contentTotal) },
      { stream: 'tips', amount: round2(tipsTotal) },
      { stream: 'dm', amount: round2(dmPayable + dmHeld) },
      // Deliberately a credit COUNT, not naira — see class-level doc comment.
      { stream: 'community_credits', amount: creditsSpentTotal },
    ];

    return { total, payable, held, recentSales, streamBreakdown };
  }
}

/** Round to kobo (2dp) — amounts are integer-naira at the row level but commission math can produce fractional kobo. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
