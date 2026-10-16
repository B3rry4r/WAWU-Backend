import type { PaymentKind } from '../../money/dto/money-enums';

/**
 * What a tier purchase is (TIER-03): a first purchase (`tier`, also after the
 * last one ended), the same tier again (`renew`), or a move to a bigger tier
 * (`upgrade`).
 */
export const PLAN_PURCHASE_KINDS = ['tier', 'renew', 'upgrade'] as const;
export type PlanPurchaseKind = (typeof PLAN_PURCHASE_KINDS)[number];

/** The only way to pay for a purchase today. */
export const PLAN_PURCHASE_METHODS = ['wallet'] as const;
export type PlanPurchaseMethod = (typeof PLAN_PURCHASE_METHODS)[number];

/** The payment kinds a purchase is paid under: with or without the checkout offer. */
export const PLAN_PAYMENT_KINDS = [
  'tier',
  'tier_bump',
] as const satisfies readonly PaymentKind[];
export type PlanPaymentKind = (typeof PLAN_PAYMENT_KINDS)[number];

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
