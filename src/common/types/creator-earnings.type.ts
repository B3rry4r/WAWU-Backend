/**
 * CreatorEarnings has NO Prisma model (see prisma/schema.prisma header
 * comment) — the registry's own endpoint note says explicitly "not a
 * running ledger balance", i.e. it's a flat aggregate computed at request
 * time across Purchase + DirectMessage + CreditSpend + CreatorSubscription
 * (docs/02_TECHNICAL_CONTEXT.md §3.7). This is the wire-response interface
 * only.
 */

/** registry.json resource field list (creatorWawuId, payable, held, thisMonth). */
export interface CreatorEarningsSummary {
  creatorWawuId: string;
  /** naira */
  payable: number;
  /** naira */
  held: number;
  /** naira */
  thisMonth: number;
}

export interface CreatorEarningsRecentSale {
  id: string;
  source: 'content' | 'tip' | 'dm' | 'community_credits' | 'subscription';
  amount: number;
  occurredAt: string;
}

export interface CreatorEarningsStreamBreakdownEntry {
  stream: 'content' | 'tips' | 'dm' | 'community_credits';
  amount: number;
}

/** Actual GET /content/mine/earnings response.shape. */
export interface CreatorEarningsResponse {
  total: number;
  payable: number;
  held: number;
  recentSales: CreatorEarningsRecentSale[];
  streamBreakdown: CreatorEarningsStreamBreakdownEntry[];
}
