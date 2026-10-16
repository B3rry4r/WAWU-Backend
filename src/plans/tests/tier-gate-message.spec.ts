import {
  TierGateError,
  productLimitMessage,
  tierRequiredMessage,
  type EndedTier,
  type TierGateOffers,
} from '../tier-gate-error';
import type { PlanTierView } from '../plans-view.type';

/**
 * The sentence a person reads when publishing is refused (TIER-02 round 2,
 * D4). It promises only the ways on that the answer carries, and the number
 * in it is the allowance, never a constant.
 */

const higher = [{ id: 'plus' }] as unknown as PlanTierView[];
const PLUS: EndedTier = { id: 'plus', name: 'Verify Plus' };
const VERIFY: EndedTier = { id: 'verify', name: 'Verify' };
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
  });

  // ── Round 3, D6: more published than the allowance ───────────────────────

  it('above the allowance, names both numbers plainly and says products must come down', () => {
    // A tick ended with 25 pieces up and a smaller tier was bought: no offer
    // lets another go up, so none is promised.
    expect(productLimitMessage(25, 3, offers([], null))).toBe(
      'You have 25 products and your plan allows 3. To publish another, remove some.',
    );
    // Round 2 pinned "You've used all 25 of your product places." for 27 of
    // 25; above the allowance it is the two numbers that are named.
    expect(productLimitMessage(27, 25, offers([], null))).toBe(
      'You have 27 products and your plan allows 25. To publish another, remove some.',
    );
  });

  it('above the allowance, adds "add more places" only while an offer would really let another go up', () => {
    const sentence =
      'You have 5 products and your plan allows 3. To publish another, remove some or add more places.';
    expect(productLimitMessage(5, 3, offers(higher, extras))).toBe(sentence);
    expect(productLimitMessage(5, 3, offers([], extras))).toBe(sentence);
    expect(productLimitMessage(5, 3, offers(higher, null))).toBe(sentence);
    // Offers not known yet (before the route adds them): the ways are open.
    expect(productLimitMessage(5, 3)).toBe(sentence);
  });

  it('at exactly the allowance the round 2 sentences are unchanged', () => {
    expect(productLimitMessage(3, 3, offers([], null))).toBe(
      "You've used all 3 of your product places.",
    );
    expect(productLimitMessage(3, 3, offers(higher, extras))).toBe(
      'You have used 3 of 3 products. Add more products or move up a tier to publish another.',
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
      for (const [used, allowed] of [
        [3, 3],
        [25, 3],
      ])
        expect(productLimitMessage(used, allowed, o)).not.toContain('—');
    expect(tierRequiredMessage('none')).not.toContain('—');
    expect(tierRequiredMessage('ended')).not.toContain('—');
  });
});

describe('tierRequiredMessage', () => {
  it('asks for a tier while a tier would let the person publish', () => {
    // Nothing up, or tiers big enough for what is up: the plain sentence.
    for (const used of [0, 4, 9]) {
      expect(tierRequiredMessage('none', used, offers(higher, null))).toBe(
        'Publishing and uploading files need a tier. Pick one to carry on. Drafts stay free.',
      );
      // The ended tier is on offer (Plus is in `higher`): renewing it works.
      expect(
        tierRequiredMessage('ended', used, offers(higher, null), PLUS),
      ).toBe(
        'Your tier has ended. Renew it to publish or upload files. Everything you published stays up.',
      );
    }
    // Before the offers are known (the bare refusal) it is the same.
    expect(tierRequiredMessage('none', 12)).toBe(tierRequiredMessage('none'));
    expect(tierRequiredMessage('ended', 12)).toBe(tierRequiredMessage('ended'));
  });

  it('with products up and no tier that would leave a place, says so with the number and that some must come down (round 4, D7)', () => {
    expect(tierRequiredMessage('none', 12, offers([], null))).toBe(
      'You have 12 products up and no plan has room for another. Remove some to publish.',
    );
    expect(tierRequiredMessage('none', 25, offers([], null))).toBe(
      'You have 25 products up and no plan has room for another. Remove some to publish.',
    );
    expect(tierRequiredMessage('none', 1, offers([], null))).toBe(
      'You have 1 product up and no plan has room for another. Remove some to publish.',
    );
    expect(tierRequiredMessage('ended', 12, offers([], null))).toBe(
      'Your tier has ended. You have 12 products up and no plan has room for another. Remove some to publish.',
    );
  });

  it('nothing up and no tier on offer is not told to remove anything', () => {
    // No tiers configured at all; there is nothing to remove.
    expect(tierRequiredMessage('none', 0, offers([], null))).toBe(
      tierRequiredMessage('none'),
    );
  });

  it('never carries an em-dash or an en-dash', () => {
    for (const state of ['none', 'ended'] as const)
      for (const used of [0, 1, 12, 25])
        for (const o of [undefined, offers([], null), offers(higher, null)])
          expect(tierRequiredMessage(state, used, o)).not.toMatch(/[—–]/);
  });
});

describe('tierRequiredMessage, an ended tier (round 5, D8)', () => {
  const RENEW =
    'Your tier has ended. Renew it to publish or upload files. Everything you published stays up.';

  it('says "Renew it" only when the ended tier is among the offered tiers', () => {
    // Plus is offered, so renewing Plus is a way on.
    expect(tierRequiredMessage('ended', 4, offers(higher, null), PLUS)).toBe(
      RENEW,
    );
    // Verify is not offered (it holds no more than the products up): the
    // sentence does not tell the person to renew it.
    const message = tierRequiredMessage(
      'ended',
      5,
      offers(higher, null),
      VERIFY,
    );
    expect(message).not.toMatch(/renew/i);
    expect(message).toBe(
      'Your Verify plan has ended. You have 5 products up, and a bigger plan has room for them.',
    );
  });

  it('takes the tier name and the number of products from the data, in the singular and the plural', () => {
    expect(tierRequiredMessage('ended', 7, offers(higher, null), PLUS)).toBe(
      RENEW,
    );
    for (const [ended, used] of [
      [{ id: 'verify', name: 'Verify' }, 6],
      [{ id: 'founding', name: 'Founding Maker' }, 12],
      [{ id: 'zeta', name: 'Zeta' }, 1],
    ] as const)
      expect(
        tierRequiredMessage('ended', used, offers(higher, null), ended),
      ).toBe(
        `Your ${ended.name} plan has ended. You have ${used} ${used === 1 ? 'product' : 'products'} up, and a bigger plan has room for ${used === 1 ? 'it' : 'them'}.`,
      );
  });

  it('a tier the config no longer names is not "bigger" than anything and is not told to renew', () => {
    const gone: EndedTier = { id: 'retired-tier', name: null };
    expect(tierRequiredMessage('ended', 5, offers(higher, null), gone)).toBe(
      'Your plan has ended. You have 5 products up, and another plan has room for them.',
    );
    // Nothing up: no count to give, only the way on.
    expect(tierRequiredMessage('ended', 0, offers(higher, null), gone)).toBe(
      'Your plan has ended. Pick a plan to carry on.',
    );
  });

  it('with no tier on offer and products up, the round 4 sentence stands whatever tier ended', () => {
    expect(tierRequiredMessage('ended', 12, offers([], null), PLUS)).toBe(
      'Your tier has ended. You have 12 products up and no plan has room for another. Remove some to publish.',
    );
  });

  it('when the ended tier is not known, or the offers are not, it cannot judge and keeps the old sentence', () => {
    expect(tierRequiredMessage('ended', 5, offers(higher, null))).toBe(RENEW);
    expect(tierRequiredMessage('ended', 5, offers(higher, null), null)).toBe(
      RENEW,
    );
    expect(tierRequiredMessage('ended', 5, undefined, VERIFY)).toBe(RENEW);
  });

  it('a person with no tier is never told to renew anything', () => {
    expect(tierRequiredMessage('none', 5, offers(higher, null), VERIFY)).toBe(
      'Publishing and uploading files need a tier. Pick one to carry on. Drafts stay free.',
    );
  });

  it('never carries an em-dash or an en-dash', () => {
    for (const ended of [PLUS, VERIFY, { id: 'x', name: null }])
      for (const used of [0, 1, 5, 12])
        for (const o of [undefined, offers([], null), offers(higher, null)])
          expect(tierRequiredMessage('ended', used, o, ended)).not.toMatch(
            /[—–]/,
          );
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

  it('leaves the tier_required sentence as it was while a tier is on offer', () => {
    const bare = new TierGateError(
      'tier_required',
      tierRequiredMessage('none'),
      { ...facts, tierState: 'none', productsAllowed: 0 },
    );
    expect(messageOf(bare.withOffers(offers(higher, extras)))).toBe(
      tierRequiredMessage('none'),
    );
  });

  it('writes the tier_required sentence again when no tier is on offer (round 4, D7)', () => {
    const bare = new TierGateError(
      'tier_required',
      tierRequiredMessage('none'),
      { tierState: 'none', productsUsed: 12, productsAllowed: 0 },
    );
    expect(messageOf(bare)).toContain('Pick one to carry on');
    const full = bare.withOffers(offers([], null));
    expect(messageOf(full)).toBe(
      'You have 12 products up and no plan has room for another. Remove some to publish.',
    );
    expect(
      (full.getResponse() as { reason: { message: string } }).reason.message,
    ).toBe(messageOf(full));
    expect(full.getStatus()).toBe(402);
    // An ended tier keeps its opening line.
    const ended = new TierGateError(
      'tier_required',
      tierRequiredMessage('ended'),
      { tierState: 'ended', productsUsed: 12, productsAllowed: 0 },
    ).withOffers(offers([], null));
    expect(messageOf(ended)).toBe(
      'Your tier has ended. You have 12 products up and no plan has room for another. Remove some to publish.',
    );
  });

  it('writes the ended tier into the sentence only when it is not among the offers (round 5, D8)', () => {
    const ended = new TierGateError(
      'tier_required',
      tierRequiredMessage('ended'),
      { tierState: 'ended', productsUsed: 5, productsAllowed: 0 },
    );
    // Verify ended, Plus offered: Verify is not a way on.
    const notOffered = ended.withOffers(offers(higher, null), VERIFY);
    expect(messageOf(notOffered)).toBe(
      'Your Verify plan has ended. You have 5 products up, and a bigger plan has room for them.',
    );
    expect(
      (notOffered.getResponse() as { reason: { message: string } }).reason
        .message,
    ).toBe(messageOf(notOffered));
    // The tier that ended is not put in the body.
    expect(JSON.stringify(notOffered.getResponse())).not.toContain('endedTier');
    // Plus ended, Plus offered: renewing it works.
    expect(messageOf(ended.withOffers(offers(higher, null), PLUS))).toBe(
      tierRequiredMessage('ended'),
    );
    // No ended tier passed: as before.
    expect(messageOf(ended.withOffers(offers(higher, null)))).toBe(
      tierRequiredMessage('ended'),
    );
  });
});
