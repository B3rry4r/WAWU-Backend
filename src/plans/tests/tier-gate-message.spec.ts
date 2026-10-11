import {
  TierGateError,
  productLimitMessage,
  tierRequiredMessage,
  type TierGateOffers,
} from '../tier-gate-error';
import type { PlanTierView } from '../plans-view.type';

/**
 * The sentence a person reads when publishing is refused (TIER-02 round 2,
 * D4). It promises only the ways on that the answer carries, and the number
 * in it is the allowance, never a constant.
 */

const higher = [{ id: 'plus' }] as unknown as PlanTierView[];
const extras = { count: 5, priceMinor: 150_000 };

const offers = (
  tiers: PlanTierView[],
  extraProducts: TierGateOffers['extraProducts'],
): TierGateOffers => ({ currency: 'NGN', tiers, extraProducts });

describe('productLimitMessage', () => {
  it('names both ways on when a higher tier and extra products are offered', () => {
    expect(productLimitMessage(3, 3, offers(higher, extras))).toBe(
      'You have used 3 of 3 products. Add more products or move up a tier to publish another.',
    );
  });

  it('names only more products when no higher tier exists', () => {
    expect(productLimitMessage(10, 10, offers([], extras))).toBe(
      'You have used 10 of 10 products. Add more products to publish another.',
    );
  });

  it('names only a higher tier when no extra products can be bought', () => {
    expect(productLimitMessage(3, 3, offers(higher, null))).toBe(
      'You have used 3 of 3 products. Move up a tier to publish another.',
    );
  });

  it('names the limit alone when nothing can be bought, with the allowance in it', () => {
    for (const allowed of [7, 25, 40])
      expect(productLimitMessage(allowed, allowed, offers([], null))).toBe(
        `You've used all ${allowed} of your product places.`,
      );
    // Above the allowance (a tier that ended with more pieces up) it is
    // still the allowance that is named.
    expect(productLimitMessage(27, 25, offers([], null))).toBe(
      "You've used all 25 of your product places.",
    );
  });

  it('names both ways when the offers are not known', () => {
    expect(productLimitMessage(3, 3)).toBe(
      'You have used 3 of 3 products. Add more products or move up a tier to publish another.',
    );
  });

  it('never carries an em-dash', () => {
    for (const o of [
      undefined,
      offers(higher, extras),
      offers([], extras),
      offers(higher, null),
      offers([], null),
    ])
      expect(productLimitMessage(3, 3, o)).not.toContain('—');
    expect(tierRequiredMessage('none')).not.toContain('—');
    expect(tierRequiredMessage('ended')).not.toContain('—');
  });
});

describe('TierGateError.withOffers', () => {
  const facts = {
    tierState: 'active' as const,
    productsUsed: 25,
    productsAllowed: 25,
  };
  const messageOf = (e: TierGateError) =>
    (e.getResponse() as { message: string; reason: { message: string } })
      .message;

  it('writes the limit sentence again from the offers it is given', () => {
    const bare = new TierGateError(
      'product_limit_reached',
      productLimitMessage(25, 25),
      facts,
    );
    expect(messageOf(bare)).toContain('move up a tier');
    const full = bare.withOffers(offers([], null));
    expect(messageOf(full)).toBe("You've used all 25 of your product places.");
    expect(
      (full.getResponse() as { reason: { message: string } }).reason.message,
    ).toBe(messageOf(full));
  });

  it('leaves the tier_required sentence as it was', () => {
    const bare = new TierGateError(
      'tier_required',
      tierRequiredMessage('none'),
      { ...facts, tierState: 'none', productsAllowed: 0 },
    );
    expect(messageOf(bare.withOffers(offers(higher, extras)))).toBe(
      tierRequiredMessage('none'),
    );
  });
});
