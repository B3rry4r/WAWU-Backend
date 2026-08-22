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
  /**
   * Naira, EXCEPT `community_credits` where this stays a raw credit COUNT.
   * Kept that way on purpose: the shipped app renders this field as
   * `${amount} credits` for that source (WAWU-Web
   * src/lib/earnings-display.ts, saleAmountDisplay), and CLAUDE.md forbids a
   * credit count ever being shown as naira. Read `earningsNaira` for the
   * money.
   */
  amount: number;
  /**
   * ADDITIVE (2026-08-22). Naira the creator actually earned from this sale,
   * net of WAWU's commission — for EVERY source including
   * `community_credits`, which used to have no naira value at all. For the
   * naira sources this equals `amount`; for credits it is the host's 90%
   * share of what the spent credits actually cost their buyer
   * (docs/01_SPEC.md §1 row 4). See
   * src/credit-spend/credit-spend.service.ts § "THE COST-BASIS MODEL".
   */
  earningsNaira: number;
}

export interface CreatorEarningsStreamBreakdownEntry {
  stream: 'content' | 'tips' | 'dm' | 'community_credits';
  /**
   * Naira, EXCEPT `community_credits` where this stays a raw credit COUNT —
   * same reason as CreatorEarningsRecentSale.amount above.
   */
  amount: number;
  /** ADDITIVE (2026-08-22). Naira earned from this stream. Always money. */
  earningsNaira: number;
}

/** Actual GET /content/mine/earnings response.shape. */
export interface CreatorEarningsResponse {
  /**
   * naira — payable + held. Since 2026-08-22 this INCLUDES the host's 90%
   * share of credits spent in their communities; it previously excluded
   * that stream entirely, which is why a community host could run a busy
   * room for a year and see ₦0.
   */
  total: number;
  /** naira. Includes credit earnings — a spent credit is money already banked. */
  payable: number;
  held: number;
  recentSales: CreatorEarningsRecentSale[];
  streamBreakdown: CreatorEarningsStreamBreakdownEntry[];
}
