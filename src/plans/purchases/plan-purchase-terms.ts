import type { PaymentKind } from '../../money/dto/money-enums';

/**
 * What a tier purchase is (TIER-03): a first purchase (`tier`, also after the
 * last one ended), the same tier again (`renew`), or a move to a bigger tier
 * (`upgrade`).
 */
export const PLAN_PURCHASE_KINDS = ['tier', 'renew', 'upgrade'] as const;
export type PlanPurchaseKind = (typeof PLAN_PURCHASE_KINDS)[number];

/**
 * The `kind` of a points pack purchase (POINTS-02): `POST /plans/purchases`
 * and `GET /plans/purchases/quote` take it beside the tier kinds, with a
 * `packId` instead of a `tierId`. A tier's own views keep `PlanPurchaseKind`;
 * a pack's answers carry this one.
 */
export const POINTS_PACK_KIND = 'points_pack' as const;

/**
 * The `kind` of an extra products purchase (TIER-04, VF13): `POST
 * /plans/purchases` and `GET /plans/purchases/quote` take it with no `tierId`,
 * `packId` or `bump`: what is bought is the one add-on the settings describe
 * (how many products, at what price), put on the tier the person holds.
 */
export const EXTRA_PRODUCTS_KIND = 'extra_products' as const;

/** Everything the purchase routes accept as `kind`. */
export const PLAN_PURCHASE_REQUEST_KINDS = [
  ...PLAN_PURCHASE_KINDS,
  POINTS_PACK_KIND,
  EXTRA_PRODUCTS_KIND,
] as const;
export type PlanPurchaseRequestKind =
  (typeof PLAN_PURCHASE_REQUEST_KINDS)[number];

/**
 * How a purchase is paid: `wallet` takes the money from the wallet now;
 * `transfer` (TIER-05) waits for the person to send the money to their own
 * wallet account and pays from the wallet the moment it lands.
 */
export const PLAN_PURCHASE_METHODS = ['wallet', 'transfer'] as const;
export type PlanPurchaseMethod = (typeof PLAN_PURCHASE_METHODS)[number];

/** The route a purchase's Idempotency-Key is scoped to. */
export const PLAN_PURCHASE_ROUTE = 'POST plans/purchases';

/** The payment kinds a tier purchase is paid under: with or without the checkout offer. */
export const PLAN_PAYMENT_KINDS = [
  'tier',
  'tier_bump',
] as const satisfies readonly PaymentKind[];
export type PlanPaymentKind = (typeof PLAN_PAYMENT_KINDS)[number];

/**
 * Every payment kind the purchase routes take: a tier's two, a points pack's
 * (POINTS-02) and the extra products' (TIER-04).
 */
export const PURCHASE_PAYMENT_KINDS = [
  ...PLAN_PAYMENT_KINDS,
  POINTS_PACK_KIND,
  EXTRA_PRODUCTS_KIND,
] as const satisfies readonly PaymentKind[];
export type PurchasePaymentKind = (typeof PURCHASE_PAYMENT_KINDS)[number];

/** A payment's `targetId` is at most this long (the money contract's pattern). */
export const TARGET_ID_MAX_LENGTH = 64;

/** Everything that decides what a purchase costs and gives. */
export interface PurchaseTerms {
  kind: PlanPurchaseKind;
  /** The tier bought, renewed or moved to. */
  tierId: string;
  /** The tier an upgrade moves from; null for the other kinds. */
  fromTierId: string | null;
  /** The checkout offer's extra points are bought with it. */
  bump: boolean;
}

const ID = '[a-z][a-z0-9_]*';
const SIMPLE = new RegExp(`^(tier|renew)-(${ID})$`);
const UPGRADE = new RegExp(`^upgrade-(${ID})-(${ID})$`);

/** `tier_bump` when the checkout offer is bought with the plan, else `tier`. */
export function paymentKindOf(bump: boolean): PlanPaymentKind {
  return bump ? 'tier_bump' : 'tier';
}

/**
 * The payment's `targetId`, which carries the terms: `tier-founding`,
 * `renew-founding` or `upgrade-verify-founding` (tier ids are lower-case
 * letters, digits and `_`, so `-` never appears inside one). The payment
 * freezes its kind and target when it is claimed, so what is delivered is
 * what the quote priced, whatever has changed since. Null when the terms do
 * not fit a target id.
 */
export function targetIdOf(terms: PurchaseTerms): string | null {
  const id =
    terms.kind === 'upgrade'
      ? `upgrade-${terms.fromTierId ?? ''}-${terms.tierId}`
      : `${terms.kind}-${terms.tierId}`;
  const ok =
    terms.kind === 'upgrade'
      ? UPGRADE.test(id) && terms.fromTierId !== null
      : SIMPLE.test(id);
  return ok && id.length <= TARGET_ID_MAX_LENGTH ? id : null;
}

/** The terms a payment of a tier kind was made for; null for any target this module did not write. */
export function termsOf(
  paymentKind: string,
  targetId: string,
): PurchaseTerms | null {
  if (paymentKind !== 'tier' && paymentKind !== 'tier_bump') return null;
  const bump = paymentKind === 'tier_bump';
  const simple = SIMPLE.exec(targetId);
  if (simple) {
    const [, kind, tierId] = simple;
    return { kind: kind as 'tier' | 'renew', tierId, fromTierId: null, bump };
  }
  const upgrade = UPGRADE.exec(targetId);
  if (upgrade) {
    const [, fromTierId, tierId] = upgrade;
    return { kind: 'upgrade', tierId, fromTierId, bump };
  }
  return null;
}

const PACK = new RegExp(`^pack-(${ID})$`);

/**
 * The payment's `targetId` for a points pack: `pack-s`. Pack ids are
 * lower-case letters, digits and `_` (the plans file), so `-` never appears
 * inside one. Null when it does not fit a target id.
 */
export function packTargetIdOf(packId: string): string | null {
  const id = `pack-${packId}`;
  return PACK.test(id) && id.length <= TARGET_ID_MAX_LENGTH ? id : null;
}

/** The pack a payment of kind `points_pack` was made for; null for any target this module did not write. */
export function packIdOf(paymentKind: string, targetId: string): string | null {
  if (paymentKind !== POINTS_PACK_KIND) return null;
  return PACK.exec(targetId)?.[1] ?? null;
}

/**
 * The payment's `targetId` for the extra products add-on. There is one add-on,
 * so the target names it and nothing else: how many products it holds and what
 * it costs are the settings' (and the payment's terms keep what was quoted).
 */
export const EXTRA_PRODUCTS_TARGET_ID = 'extra-products';

/** Whether a payment of this kind and target is the extra products add-on. */
export function isExtraProducts(
  paymentKind: string,
  targetId: string,
): boolean {
  return (
    paymentKind === EXTRA_PRODUCTS_KIND && targetId === EXTRA_PRODUCTS_TARGET_ID
  );
}
