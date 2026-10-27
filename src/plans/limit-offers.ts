import type { PublishingAllowance } from './publishing-allowance.service';
import type { PlansView } from './plans-view.type';
import type { TierGateOffers } from './tier-gate-error';
import { packRefusalFor, type PackRule } from './purchases/extra-products-cap';

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
 *   pack is bought on one), the pack lifts that tier above what is
 *   published, and the pack rule allows it (PACK-CAP, R-100): the tier is one
 *   the settings name (Founding Maker by default) and the person holds fewer
 *   than the most packs. A person on Verify or Verify Plus is offered tiers
 *   only.
 *
 * When nothing counts both come back empty and the sentence says products
 * must come down first.
 *
 * `tier_required` follows the same rule (TIER-02 round 4, D7): see
 * `tierRequiredOffers`.
 */
export function limitOffers(
  allowance: Pick<
    PublishingAllowance,
    'productsUsed' | 'runningTierId' | 'runningTierProducts' | 'extraProducts'
  >,
  plan: Pick<PlansView, 'tiers' | 'extraProducts'>,
  rule: PackRule,
): Pick<TierGateOffers, 'tiers' | 'extraProducts'> {
  const used = allowance.productsUsed;
  const tiers = tiersWithRoom(allowance, plan);
  const packSold =
    allowance.runningTierId !== null &&
    packRefusalFor(rule, allowance.runningTierId, allowance.extraProducts) ===
      null;
  const withPack =
    allowance.runningTierProducts +
    allowance.extraProducts +
    plan.extraProducts.count;
  return {
    tiers,
    extraProducts: packSold && withPack > used ? plan.extraProducts : null,
  };
}

/**
 * The tiers that, once bought, leave more places than the person has products
 * published. The extras they hold carry over a purchase (they are 0 for a
 * person with no running tier, whose old extras are not counted).
 */
function tiersWithRoom(
  allowance: Pick<PublishingAllowance, 'productsUsed' | 'extraProducts'>,
  plan: Pick<PlansView, 'tiers'>,
): PlansView['tiers'] {
  return plan.tiers.filter(
    (t) => t.products + allowance.extraProducts > allowance.productsUsed,
  );
}

/**
 * The offers a `tier_required` refusal carries (TIER-02 round 4, D7): the same
 * rule as the limit, applied one step earlier. A person with no running tier
 * and no tick may still have products published (the tick ended, or the tier
 * did); a tier is offered only if buying it leaves more places than they have
 * products up, so no tier is offered that the next publish would refuse. For
 * someone with nothing published that is every tier. When none counts the
 * list is empty and the sentence says products must come down first.
 *
 * The extra-products pack is never offered here: it is bought on a running
 * tier, and this person has none.
 */
export function tierRequiredOffers(
  allowance: Pick<PublishingAllowance, 'productsUsed' | 'extraProducts'>,
  plan: Pick<PlansView, 'tiers'>,
): Pick<TierGateOffers, 'tiers' | 'extraProducts'> {
  return { tiers: tiersWithRoom(allowance, plan), extraProducts: null };
}
