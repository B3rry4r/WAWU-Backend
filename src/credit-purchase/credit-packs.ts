import { CreditPack } from '../../generated/prisma/enums';

/**
 * `CreditPurchase.amount` is whole naira (every pack price is). Cost basis is
 * carried in kobo so the per-credit maths on a ₦1,000/120 pack stays exact
 * integer arithmetic instead of drifting through 8.3333 floats.
 */
export const KOBO_PER_NAIRA = 100;

/**
 * Server-side pack->price/credits table (registry.json CreditPurchase note:
 * "pack->amount/credits looked up server-side ... per product-truths.json").
 * Never accepted from the client. Both ways to buy a pack read it: the web's
 * Flutterwave charge (`POST /credits/purchase`) and the wallet payment
 * (INBOX-16, kind `credit_pack`), so a pack is one price on both.
 */
export const PACK_TABLE: Record<
  CreditPack,
  { amount: number; credits: number }
> = {
  starter: { amount: 500, credits: 50 },
  popular: { amount: 1000, credits: 120 },
  pro: { amount: 2000, credits: 300 },
};

/** The pack a payment target names, or null when it names none. */
export function packOf(targetId: string): CreditPack | null {
  return Object.prototype.hasOwnProperty.call(PACK_TABLE, targetId)
    ? (targetId as CreditPack)
    : null;
}
