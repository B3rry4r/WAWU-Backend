import type { BillingCurrency } from '../../../generated/prisma/enums';
import type { HeldTier } from '../maker-tier.service';
import {
  countIn,
  priceIn,
  tierById,
  type PlanTier,
  type PlansConfig,
} from '../plans-config';
import type { PurchaseTerms } from './plan-purchase-terms';

/**
 * What a person may buy, and what it costs (TIER-03). Pure: the config, the
 * billing currency, what the person holds and the terms in, a plan or a
 * refusal out. Every figure is read from the checked config (`priceIn`,
 * `countIn`); none is written here.
 *
 * Default (agent), owner may override:
 *  - `tier`: a first purchase, or a new one after the last ended. A person
 *    whose tier is running renews it or upgrades it instead.
 *  - `renew`: the tier the person holds (any state), at its config price. The
 *    new period starts where the running one ends (or now, if it ended).
 *  - `upgrade`: from the running tier to a tier that costs more, paying the
 *    DIFFERENCE of the two config prices. No downgrade while a tier runs.
 *  - The checkout offer (`bump`) may be added to any of them.
 */

export const PLAN_NOT_FOUND_MESSAGE = 'We could not find that plan.';
export const PLAN_RUNNING_MESSAGE =
  'You already have a plan running. Renew it or upgrade it instead.';
export const NOTHING_TO_RENEW_MESSAGE =
  "You don't have a plan to renew yet. Pick a plan instead.";
export const RENEW_SAME_PLAN_MESSAGE =
  'You can only renew the plan you have. Upgrade to move to a bigger one.';
export const NOTHING_TO_UPGRADE_MESSAGE =
  'You need a plan that is running to upgrade it. Pick a plan instead.';
export const PLAN_CHANGED_MESSAGE =
  'Your plan changed. Check it and try again.';
export const CANNOT_PRICE_UPGRADE_MESSAGE =
  "We can't price an upgrade from your current plan. Renew it instead.";
export const SAME_PLAN_MESSAGE = 'That is the plan you have. Renew it instead.';
export const NO_DOWNGRADE_MESSAGE =
  "You can't move to a smaller plan while yours is running.";

/** Why a purchase cannot be made, as the money error code it answers with. */
export class PurchaseRefusal extends Error {
  constructor(
    readonly code: 'target_not_found' | 'target_not_payable' | 'tier_required',
    message: string,
  ) {
    super(message);
    this.name = 'PurchaseRefusal';
  }
}

/** A purchase priced: what it costs and what the checkout offer adds. */
export interface PurchasePlan {
  terms: PurchaseTerms;
  tier: PlanTier;
  /** The tier an upgrade moves from. */
  fromTier: PlanTier | null;
  currency: BillingCurrency;
  /** The tier's price, or the difference on an upgrade, in minor units. */
  planMinor: number;
  /** The checkout offer's price when it is bought, else 0. */
  bumpMinor: number;
  /** `planMinor` plus `bumpMinor`: the price of the payment. */
  totalMinor: number;
  /** The checkout offer's points when it is bought, else 0. */
  bumpPoints: number;
}

/** Whether the person's tier is running (`active` or `ending`). */
export function isRunning(held: Pick<HeldTier, 'state'>): boolean {
  return held.state === 'active' || held.state === 'ending';
}

/**
 * Prices a purchase for a person, or refuses it. `held` is what the person
 * holds now. The refusals are the ones in the messages above.
 */
export function planPurchase(
  config: PlansConfig,
  currency: BillingCurrency,
  held: Pick<HeldTier, 'state' | 'tierId' | 'tier'>,
  terms: PurchaseTerms,
): PurchasePlan {
  const tier = tierById(config, terms.tierId);
  if (tier === null)
    throw new PurchaseRefusal('target_not_found', PLAN_NOT_FOUND_MESSAGE);

  let fromTier: PlanTier | null = null;
  let planMinor = priceIn(tier.price, currency);

  if (terms.kind === 'tier') {
    if (isRunning(held))
      throw new PurchaseRefusal('target_not_payable', PLAN_RUNNING_MESSAGE);
  } else if (terms.kind === 'renew') {
    if (held.state === 'none')
      throw new PurchaseRefusal('target_not_payable', NOTHING_TO_RENEW_MESSAGE);
    if (held.tierId !== tier.id)
      throw new PurchaseRefusal('target_not_payable', RENEW_SAME_PLAN_MESSAGE);
  } else {
    if (!isRunning(held))
      throw new PurchaseRefusal(
        'target_not_payable',
        NOTHING_TO_UPGRADE_MESSAGE,
      );
    if (held.tierId !== terms.fromTierId)
      throw new PurchaseRefusal('target_not_payable', PLAN_CHANGED_MESSAGE);
    fromTier = held.tier;
    if (fromTier === null)
      throw new PurchaseRefusal(
        'target_not_payable',
        CANNOT_PRICE_UPGRADE_MESSAGE,
      );
    if (fromTier.id === tier.id)
      throw new PurchaseRefusal('target_not_payable', SAME_PLAN_MESSAGE);
    planMinor -= priceIn(fromTier.price, currency);
    if (planMinor < 1)
      throw new PurchaseRefusal('target_not_payable', NO_DOWNGRADE_MESSAGE);
  }

  const bumpMinor = terms.bump
    ? priceIn(config.checkoutBump.price, currency)
    : 0;
  return {
    terms,
    tier,
    fromTier,
    currency,
    planMinor,
    bumpMinor,
    totalMinor: planMinor + bumpMinor,
    bumpPoints: terms.bump ? countIn(config.checkoutBump.points, currency) : 0,
  };
}

/** The line the payment (and so the history row) is titled with: no figure in it. */
export function purchaseTitle(plan: PurchasePlan): string {
  const name =
    plan.terms.kind === 'renew'
      ? `${plan.tier.name} renewal`
      : plan.terms.kind === 'upgrade'
        ? `Upgrade to ${plan.tier.name}`
        : plan.tier.name;
  return plan.terms.bump ? `${name} and bonus points` : name;
}
