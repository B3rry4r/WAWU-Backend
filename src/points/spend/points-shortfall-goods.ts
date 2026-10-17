import type { PayableTerms } from '../../money/payments/payable-terms';
import { INT4_MAX } from '../../plans/plans-config';
import { termsFromJson } from '../../money/payments/payable-terms';

/**
 * What a wallet shortfall buys, as the quote showed it (task POINTS-03, as
 * POINTS-02 does for a pack): the points, the rate they were worked out at
 * and the days the lot lasts. It is the payment's `terms`: the quote token is
 * bound to it, so a rate or an expiry that changed after the quote makes the
 * quote stale (`409 quote_changed`), and the payment keeps it from the claim,
 * so the lot that is granted is the lot that was quoted whatever the settings
 * say by then.
 */
export interface ShortfallGoods {
  points: number;
  /** The rate in force when it was quoted: minor units for a thousand points. */
  per1000Minor: number;
  expiryDays: number;
}

const TERMS_VERSION = 1;

export function shortfallGoodsToTerms(goods: ShortfallGoods): PayableTerms {
  return {
    v: TERMS_VERSION,
    points: goods.points,
    per1000Minor: goods.per1000Minor,
    expiryDays: goods.expiryDays,
  };
}

/**
 * The goods a payment was claimed with. Throws for terms that are missing or
 * are not goods: a delivery then fails and goes to review with the money
 * safe, never granting a guess.
 */
export function shortfallGoodsFromTerms(
  terms: PayableTerms | undefined,
): ShortfallGoods {
  if (terms === undefined)
    throw new Error('The payment has no terms, so it names no points.');
  if (terms.v !== TERMS_VERSION)
    throw new Error(
      "The payment's terms are of a version this server cannot read.",
    );
  const count = (key: string): number => {
    const v = terms[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)
      throw new Error(`The payment's terms have no usable ${key}.`);
    return v;
  };
  return {
    points: count('points'),
    per1000Minor: count('per1000Minor'),
    expiryDays: count('expiryDays'),
  };
}

export function shortfallGoodsFromJson(value: unknown): ShortfallGoods {
  return shortfallGoodsFromTerms(termsFromJson(value) ?? undefined);
}

/** The payment target of a shortfall of `points`: `shortfall-<points>`. */
export function shortfallTargetOf(points: number): string {
  return `shortfall-${points}`;
}

/** The points a `shortfall-<points>` target names, or null for any other text. */
export function shortfallPointsOf(targetId: string): number | null {
  const m = /^shortfall-([1-9][0-9]{0,9})$/.exec(targetId);
  if (m === null) return null;
  const n = Number(m[1]);
  return n <= INT4_MAX ? n : null;
}
