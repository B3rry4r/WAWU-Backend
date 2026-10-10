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
   * `tier_required`: every tier. `product_limit_reached`: the tiers that
   * allow more products than the one the person holds (none when they hold
   * no tier, or the top one).
   */
  tiers: PlanTierView[];
  /** The extra products they can buy now, or null when they cannot (no running tier). */
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

  /** The same refusal with its offers filled in. */
  withOffers(offers: TierGateOffers): TierGateError {
    return new TierGateError(
      this.code,
      (this.getResponse() as { message: string }).message,
      this.facts,
      offers,
    );
  }
}

/** The sentence for `tier_required`. No em-dash; a person reads it. */
export function tierRequiredMessage(tierState: MyTierState): string {
  return tierState === 'ended'
    ? 'Your tier has ended. Renew it to publish or upload files. Everything you published stays up.'
    : 'Publishing and uploading files need a tier. Pick one to carry on. Drafts stay free.';
}

/** The sentence for `product_limit_reached`. */
export function productLimitMessage(used: number, allowed: number): string {
  return `You have used ${used} of ${allowed} products. Add more products or move up a tier to publish another.`;
}
