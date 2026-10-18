import { HttpException, HttpStatus } from '@nestjs/common';
import type { PlanCurrency } from './plans-view.type';

/**
 * Why hosting an event was refused for want of a tier (EVENTS-12, R-43).
 *
 * Hosting reads the person's tier where it used to read the verification
 * tick: a running tier (`active` or `ending`) is enough, and so is a tick
 * that has not ended yet (nothing live stops working). A person with neither
 * is refused with this, in the contract's one error shape
 * (docs/contract/CONVENTIONS.md section 3).
 *
 * It stays a 403, the status POST and PATCH /events and PUT /events/:id/tickets
 * have always answered a host who may not host, so a client that handles that
 * refusal still does. `reason.code` is the new, additive part: the app
 * switches on it, never on `message`.
 */
export const HOST_TIER_REQUIRED = 'tier_required' as const;

/** `none`: never had a tier. `ended`: the tier's period is over. */
export type HostTierState = 'none' | 'ended';

/** The cheapest tier on `GET /plans`, for "From ..." under "Needs a tier". */
export interface HostTierOffer {
  /** The currency of `lowestTier.priceMinor`: the person's billing currency. */
  currency: PlanCurrency;
  /** The lowest-priced tier in the person's currency. */
  lowestTier: { id: string; name: string; priceMinor: number } | null;
}

/** The `reason` object of the refusal, flat like the publishing gate's. */
export interface HostTierReason extends Partial<HostTierOffer> {
  code: typeof HOST_TIER_REQUIRED;
  message: string;
  tierState: HostTierState;
}

/**
 * The sentence a person reads. No em-dash, and no figure: the price travels
 * in `lowestTier`, from the plan, so a sentence can never disagree with it.
 *
 * An ended tier says what still works: events already live keep selling
 * (buying a ticket never asks anything of the host), and only a new event or
 * an edit waits for a renewal.
 */
export function hostTierRequiredMessage(state: HostTierState): string {
  return state === 'ended'
    ? 'Your tier has ended. Renew it to host a new event. Events that are already live keep selling.'
    : 'Needs a tier. Pick a tier to host an event.';
}

/**
 * The refusal. The services that gate throw it with the person's tier state;
 * the route's `HostTierOffersInterceptor` adds the lowest tier, because only
 * the route knows whose token (and so whose billing currency) asked.
 */
export class HostTierRequiredError extends HttpException {
  readonly tierState: HostTierState;
  readonly offer: HostTierOffer | undefined;

  constructor(tierState: HostTierState, offer?: HostTierOffer) {
    const message = hostTierRequiredMessage(tierState);
    const reason: HostTierReason = {
      code: HOST_TIER_REQUIRED,
      message,
      tierState,
      ...offer,
    };
    super({ statusCode: 403, message, reason }, HttpStatus.FORBIDDEN);
    this.tierState = tierState;
    this.offer = offer;
  }

  /** The same refusal with the lowest tier on offer filled in. */
  withOffer(offer: HostTierOffer): HostTierRequiredError {
    return new HostTierRequiredError(this.tierState, offer);
  }
}
