import type { PayableTerms } from '../../money/payments/payable-terms';
import { termsFromJson } from '../../money/payments/payable-terms';
import type { PackPlan } from './points-pack-rules';

/**
 * Everything a points pack gives, as the quote showed it (TIER-06 round 2, as
 * for a tier): the pack's points, the Founding bonus and the days the lot
 * lasts. It is the payment's `terms`: the quote token is bound to it, so a
 * price, a pack, a bonus or an expiry changed after the quote makes the quote
 * stale (`409 quote_changed`), and the payment keeps it from the claim, so the
 * grant gives what was quoted even when a setting changes while the payment
 * confirms or a bank-transfer purchase waits.
 */
export interface PackGoods {
  packId: string;
  points: number;
  bonusPoints: number;
  boughtExpiryDays: number;
}

/** Version of the stored shape. */
const TERMS_VERSION = 1;

export function packGoodsOf(plan: PackPlan): PackGoods {
  return {
    packId: plan.pack.id,
    points: plan.points,
    bonusPoints: plan.bonusPoints,
    boughtExpiryDays: plan.boughtExpiryDays,
  };
}

export function packGoodsToTerms(goods: PackGoods): PayableTerms {
  return {
    v: TERMS_VERSION,
    packId: goods.packId,
    points: goods.points,
    bonusPoints: goods.bonusPoints,
    boughtExpiryDays: goods.boughtExpiryDays,
  };
}

/**
 * The goods a payment was claimed with. Throws for terms that are missing or
 * are not goods: a delivery then fails and goes to review with the money safe,
 * never granting a guess.
 */
export function packGoodsFromTerms(terms: PayableTerms | undefined): PackGoods {
  if (terms === undefined)
    throw new Error('The payment has no terms, so it names no points pack.');
  if (terms.v !== TERMS_VERSION)
    throw new Error(
      "The payment's terms are of a version this server cannot read.",
    );
  const count = (key: string, min: number): number => {
    const v = terms[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
      throw new Error(`The payment's terms have no usable ${key}.`);
    return v;
  };
  const packId = terms.packId;
  if (typeof packId !== 'string' || packId === '')
    throw new Error("The payment's terms have no usable packId.");
  return {
    packId,
    points: count('points', 1),
    bonusPoints: count('bonusPoints', 0),
    boughtExpiryDays: count('boughtExpiryDays', 1),
  };
}

/** The goods in the JSON a payment or an order stored. */
export function packGoodsFromJson(value: unknown): PackGoods {
  return packGoodsFromTerms(termsFromJson(value) ?? undefined);
}
