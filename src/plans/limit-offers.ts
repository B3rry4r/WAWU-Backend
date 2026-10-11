import type { PublishingAllowance } from './publishing-allowance.service';
import type { PlansView } from './plans-view.type';
import type { TierGateOffers } from './tier-gate-error';

/**
 * The offers a `product_limit_reached` refusal carries (TIER-02, R-43): only
 * what would let the person publish another product, so no offer is made
 * that the next publish would refuse again (TIER-02 round 3, D6).
 *
 * An offer counts when it raises what the person may have published at once
 * above what they have published now. What a purchase would leave them
 * allowed is the tier's products plus the extras bought. A held tick's old
 * cap is left out on purpose: this runs for a person who has used every place
 * they have, so they have published at least as many as the tick allows, and
 * a cap at or below what is published can never make an offer count. Extras
 * carry over a move to a higher tier (SHARED-CHANGES TIER-02, question 5).
 *
 * - A tier counts when it leaves more places than products published. For a
 *   person who has just used every place that is the tiers above the one
 *   they hold. For a person who has MORE published than they are allowed
 *   (a tick ended, then a small tier was bought) it is only the tiers big
 *   enough for all they have, and often none.
 * - The extra-products pack counts when the person has a running tier (the
 *   pack is bought on one) and the pack lifts that tier above what is
 *   published.
 *
 * When nothing counts both come back empty and the sentence says products
 * must come down first.
 */
export function limitOffers(
  allowance: Pick<
    PublishingAllowance,
    'productsUsed' | 'runningTierId' | 'runningTierProducts' | 'extraProducts'
  >,
  plan: Pick<PlansView, 'tiers' | 'extraProducts'>,
): Pick<TierGateOffers, 'tiers' | 'extraProducts'> {
  const used = allowance.productsUsed;
  const tiers = plan.tiers.filter(
    (t) => t.products + allowance.extraProducts > used,
  );
  const hasTier = allowance.runningTierId !== null;
  const withPack =
    allowance.runningTierProducts +
    allowance.extraProducts +
    plan.extraProducts.count;
  return {
    tiers,
    extraProducts: hasTier && withPack > used ? plan.extraProducts : null,
  };
}
