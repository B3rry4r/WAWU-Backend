import type { PayableTerms } from '../../money/payments/payable-terms';
import { tierGoodsOf, type TierGoods } from '../tier-grant.service';
import type { PurchasePlan } from './plan-purchase-rules';

/**
 * Everything a tier purchase gives, as the quote showed it (TIER-06 round 2):
 * the tier's goods and the checkout bump's points, with the days each lot of
 * bought points lasts. It is the payment's `terms`: the quote token is bound to
 * it, so a plan changed after the quote makes the quote stale (`409
 * quote_changed`), and the payment keeps it from the claim, so the grant gives
 * what was quoted even when the plan changes while the payment confirms.
 */
export interface PurchaseGoods extends TierGoods {
  /** The checkout bump's points; 0 when the bump is not bought. */
  bumpPoints: number;
  /** How long the bump's points last; 0 when the bump is not bought. */
  boughtExpiryDays: number;
}

/** Version of the stored shape. */
const TERMS_VERSION = 1;

/** The goods of a priced purchase. `boughtExpiryDays` is the plan's, taken at the same time. */
export function goodsOf(
  plan: PurchasePlan,
  boughtExpiryDays: number,
): PurchaseGoods {
  const bump = plan.terms.bump;
  return {
    ...tierGoodsOf(plan.tier),
    bumpPoints: bump ? plan.bumpPoints : 0,
    boughtExpiryDays: bump ? boughtExpiryDays : 0,
  };
}

export function goodsToTerms(goods: PurchaseGoods): PayableTerms {
  return {
    v: TERMS_VERSION,
    days: goods.days,
    products: goods.products,
    bonusPoints: goods.bonusPoints,
    bonusExpiryDays: goods.bonusExpiryDays,
    eventPass: goods.eventPass,
    firstVoiceIntro: goods.firstVoiceIntro,
    bumpPoints: goods.bumpPoints,
    boughtExpiryDays: goods.boughtExpiryDays,
  };
}

/**
 * The goods a payment was claimed with. Null when the payment has no terms (it
 * was claimed before they were kept), and then the grant reads the plan as it
 * stands. Throws for terms that are there but are not goods: the delivery then
 * fails and goes to review with the money safe, never granting a guess.
 */
export function goodsFromTerms(
  terms: PayableTerms | undefined,
): PurchaseGoods | null {
  if (terms === undefined) return null;
  const count = (key: string, min: number): number => {
    const v = terms[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
      throw new Error(`The payment's terms have no usable ${key}.`);
    return v;
  };
  if (terms.v !== TERMS_VERSION)
    throw new Error(
      "The payment's terms are of a version this server cannot read.",
    );
  const eventPass = terms.eventPass;
  if (typeof eventPass !== 'string' || eventPass === '')
    throw new Error("The payment's terms have no usable eventPass.");
  const voice = terms.firstVoiceIntro;
  if (typeof voice !== 'boolean')
    throw new Error("The payment's terms have no usable firstVoiceIntro.");
  return {
    days: count('days', 1),
    products: count('products', 0),
    bonusPoints: count('bonusPoints', 0),
    bonusExpiryDays: count('bonusExpiryDays', 0),
    eventPass,
    firstVoiceIntro: voice,
    bumpPoints: count('bumpPoints', 0),
    boughtExpiryDays: count('boughtExpiryDays', 0),
  };
}
