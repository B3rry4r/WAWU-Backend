import type { BillingCurrency } from '../../../generated/prisma/enums';
import type { HeldTier } from '../maker-tier.service';
import { INT4_MAX, priceIn, type PlansConfig } from '../plans-config';
import { isRunning, PurchaseRefusal } from './plan-purchase-rules';

/**
 * What the extra products add-on costs and gives (TIER-04, VF13). Pure: the
 * config, the billing currency and what the person holds in, a priced add-on or
 * a refusal out. Every figure is read from the checked config (`priceIn`),
 * which is the live plan the admin settings lay over the file (TIER-06, R-65);
 * none is written here.
 *
 * Default (agent), owner may override:
 *  - The add-on is bought on a tier that is running (`active` or `ending`).
 *    Without one the answer is `tier_required` and nothing moves.
 *  - What is bought stays with the account. It is added to the tier row's
 *    `extraProducts`, which a renewal, a new tier after an ended one and an
 *    upgrade leave alone, and it counts whenever the person holds a tier.
 *  - It may be bought again and again: each purchase adds the same count.
 *  - It is bought in the person's billing currency; only naira is paid from
 *    the wallet today (R-16), so a person billed in dollars is priced in
 *    dollars and the payment is refused until a dollar wallet can pay it.
 */

export const TIER_REQUIRED_MESSAGE =
  'Extra products are added to a plan you have. Pick a plan first.';
export const TIER_ENDED_MESSAGE =
  'Your plan has ended. Renew it to add more products.';
export const EXTRA_PRODUCTS_TOO_MANY_MESSAGE =
  'More products cannot be added right now.';

/** The add-on priced for a person. */
export interface ExtraProductsPlan {
  currency: BillingCurrency;
  /** The add-on's price in the minor unit of `currency`. */
  priceMinor: number;
  /** Products one add-on adds. */
  products: number;
  /** Products the person may have published at once, before this add-on. */
  productsAllowed: number;
  /** The same after this add-on: `productsAllowed` plus `products`. */
  productsAllowedAfter: number;
}

/** Prices the add-on for a person, or refuses it. */
export function priceExtraProducts(
  config: PlansConfig,
  currency: BillingCurrency,
  held: Pick<HeldTier, 'state' | 'extraProducts' | 'productsAllowed'>,
): ExtraProductsPlan {
  if (!isRunning(held))
    throw new PurchaseRefusal(
      'tier_required',
      held.state === 'ended' ? TIER_ENDED_MESSAGE : TIER_REQUIRED_MESSAGE,
    );
  const products = config.extraProducts.count;
  // The tier row keeps the total in a whole-number column: an add-on that does
  // not fit it is not sold, rather than failing after the person has paid.
  // What a creator may have published at once (included plus extra) is also
  // compared against a 32-bit column when they post, so it is held to the same
  // bound (SWEEP-MONEY, TIER-04 L1).
  if (
    held.extraProducts + products > INT4_MAX ||
    held.productsAllowed + products > INT4_MAX
  )
    throw new PurchaseRefusal(
      'target_not_payable',
      EXTRA_PRODUCTS_TOO_MANY_MESSAGE,
    );
  return {
    currency,
    priceMinor: priceIn(config.extraProducts.price, currency),
    products,
    productsAllowed: held.productsAllowed,
    productsAllowedAfter: held.productsAllowed + products,
  };
}

/** The line the payment (and so the history row) is titled with: no figure in it. */
export const EXTRA_PRODUCTS_TITLE = 'Extra products';
