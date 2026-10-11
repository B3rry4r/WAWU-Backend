import { HttpException, HttpStatus } from '@nestjs/common';
import type { PlanCurrency, MyTierState } from './plans-view.type';
import type { PlanExtraProductsView, PlanTierView } from './plans-view.type';

/**
 * Why publishing or uploading a file was refused (TIER-02, R-43).
 *
 * `tier_required`: the person has no tier that is running and no verification
 * tick that still counts, so nothing may be published or uploaded. Drafts
 * with no file are not refused.
 * `product_limit_reached`: they have a way to publish and every product it
 * allows is used.
 *
 * Both answer 402 in the contract's one error shape (docs/contract/
 * CONVENTIONS.md section 3): `{ statusCode, message, data: null, reason }`,
 * with the offers the person needs to carry on inside `reason`. The app
 * switches on `reason.code`, never on `message`.
 */
export type TierGateCode = 'tier_required' | 'product_limit_reached';

/** What the person has and has used, set by the service that refuses. */
export interface TierGateFacts {
  /** `none` (never had a tier) or `ended` for `tier_required`; any state for the limit. */
  tierState: MyTierState;
  /** Products published now (CreatorState.slotsUsed). */
  productsUsed: number;
  /** Products they may have published at once. 0 when nothing allows publishing. */
  productsAllowed: number;
}

/**
 * The offers the interceptor adds in the person's billing currency (the same
 * figures GET /plans answers, never a second copy of them).
 */
export interface TierGateOffers {
  currency: PlanCurrency;
  /**
   * The tiers that would let the person publish another, that is, once
   * bought leave more places than they have products published now (the
   * extras they hold carry over). For `tier_required` that is every tier for
   * someone with nothing published, and only the big enough ones for someone
   * who still has products up (a tick or tier ended). For
   * `product_limit_reached` it is the tiers above the one they hold. None
   * when no tier does: they hold the top one, or they have more published
   * than any tier allows.
   */
  tiers: PlanTierView[];
  /**
   * The extra products they can buy now, or null when they cannot: no running
   * tier, or buying them would still leave fewer places than products
   * published (`product_limit_reached`).
   */
  extraProducts: PlanExtraProductsView | null;
}

/**
 * The `reason` object of both refusals, flat: the offers are absent until
 * the route's interceptor adds them, and it always does.
 */
export interface TierGateReason extends TierGateFacts, Partial<TierGateOffers> {
  code: TierGateCode;
  message: string;
}

/**
 * The refusal. The services that gate throw it with the facts; the
 * `PublishingOffersInterceptor` on the route adds the offers, because only
 * the route knows whose token (and so whose billing currency) asked.
 */
export class TierGateError extends HttpException {
  readonly code: TierGateCode;
  readonly facts: TierGateFacts;
  readonly offers: TierGateOffers | undefined;

  constructor(
    code: TierGateCode,
    message: string,
    facts: TierGateFacts,
    offers?: TierGateOffers,
  ) {
    // Flat, so a generated client reads `reason.tiers` without narrowing.
    const reason: TierGateReason = { code, message, ...facts, ...offers };
    super({ message, reason }, HttpStatus.PAYMENT_REQUIRED);
    this.code = code;
    this.facts = facts;
    this.offers = offers;
  }

  /**
   * The same refusal with its offers filled in. The sentence is written again
   * from the offers (both refusals), so it never promises a way on the body
   * does not carry.
   */
  withOffers(offers: TierGateOffers): TierGateError {
    return new TierGateError(
      this.code,
      this.code === 'product_limit_reached'
        ? productLimitMessage(
            this.facts.productsUsed,
            this.facts.productsAllowed,
            offers,
          )
        : tierRequiredMessage(
            this.facts.tierState,
            this.facts.productsUsed,
            offers,
          ),
      this.facts,
      offers,
    );
  }
}

/**
 * The sentence for `tier_required`. No em-dash; a person reads it.
 *
 * With the offers known, a person who still has products published and for
 * whom no tier would leave a place (TIER-02 round 4, D7) is not told to pick
 * a tier: they are told how many products they have and that some must come
 * down first. Everyone else keeps the sentence that asks for a tier.
 */
export function tierRequiredMessage(
  tierState: MyTierState,
  used = 0,
  offers?: Pick<TierGateOffers, 'tiers'>,
): string {
  if (offers && offers.tiers.length === 0 && used > 0) {
    const have = `${used} ${used === 1 ? 'product' : 'products'}`;
    return `${tierState === 'ended' ? 'Your tier has ended. ' : ''}You have ${have} up and no plan has room for another. Remove some to publish.`;
  }
  return tierState === 'ended'
    ? 'Your tier has ended. Renew it to publish or upload files. Everything you published stays up.'
    : 'Publishing and uploading files need a tier. Pick one to carry on. Drafts stay free.';
}

/**
 * The sentence for `product_limit_reached`. It names only the ways on that
 * the answer carries (the tiers that allow more, extra products): a person at
 * the tick-era cap, or at the top of the ladder with nothing to buy, is told
 * the limit and nothing they cannot do (TIER-02 round 2, D4). With no offers
 * known, both ways are named. No em-dash.
 *
 * A person who has MORE products published than they are now allowed (a tick
 * ended, then a smaller tier was bought) is told both numbers plainly, and
 * that products must come down before another can go up; "add more places"
 * is said only while an offer in the answer would really let another go up
 * (TIER-02 round 3, D6).
 */
export function productLimitMessage(
  used: number,
  allowed: number,
  offers?: Pick<TierGateOffers, 'tiers' | 'extraProducts'>,
): string {
  const moreProducts = offers ? offers.extraProducts !== null : true;
  const higherTier = offers ? offers.tiers.length > 0 : true;
  if (used > allowed) {
    const have = `${used} ${used === 1 ? 'product' : 'products'}`;
    const base = `You have ${have} and your plan allows ${allowed}. To publish another, remove some`;
    return moreProducts || higherTier
      ? `${base} or add more places.`
      : `${base}.`;
  }
  if (!moreProducts && !higherTier)
    return `You've used all ${allowed} of your product places.`;
  const ways =
    moreProducts && higherTier
      ? 'Add more products or move up a tier'
      : moreProducts
        ? 'Add more products'
        : 'Move up a tier';
  return `You have used ${used} of ${allowed} products. ${ways} to publish another.`;
}
