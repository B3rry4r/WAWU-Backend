const TICK_UPLOADS = 25;
import { limitOffers, tierRequiredOffers } from '../limit-offers';
import type { PlanTierView } from '../plans-view.type';

/**
 * Which offers a `product_limit_reached` refusal carries (TIER-02 round 3,
 * D6): only what would let the person publish another product, judged
 * against what they have published now and not against what they are
 * allowed. The plan here is the shipped one (3, 6 and 10 products, 5 extras).
 */

const tier = (id: string, products: number) =>
  ({ id, products }) as unknown as PlanTierView;
const plan = {
  tiers: [tier('verify', 3), tier('plus', 6), tier('founding', 10)],
  extraProducts: { count: 5, priceMinor: 150_000 },
};

type Held = Parameters<typeof limitOffers>[0];
const held = (over: Partial<Held>): Held => ({
  productsUsed: 0,
  runningTierId: 'verify',
  runningTierProducts: 3,
  extraProducts: 0,
  ...over,
});
const ids = (o: ReturnType<typeof limitOffers>) => o.tiers.map((t) => t.id);

describe('limitOffers', () => {
  describe('at the limit (used equals allowed)', () => {
    it('Verify, 3 of 3: the tiers above it and the extras', () => {
      const o = limitOffers(held({ productsUsed: 3 }), plan);
      expect(ids(o)).toEqual(['plus', 'founding']);
      expect(o.extraProducts).toEqual(plan.extraProducts);
    });

    it('the top tier, 10 of 10: only the extras', () => {
      const o = limitOffers(
        held({
          productsUsed: 10,
          runningTierId: 'founding',
          runningTierProducts: 10,
        }),
        plan,
      );
      expect(ids(o)).toEqual([]);
      expect(o.extraProducts).toEqual(plan.extraProducts);
    });

    it('extras bought are kept across a move up: Verify with 5 extras, 8 of 8, is offered Plus (6 + 5)', () => {
      const o = limitOffers(held({ productsUsed: 8, extraProducts: 5 }), plan);
      expect(ids(o)).toEqual(['plus', 'founding']);
      expect(o.extraProducts).not.toBeNull();
    });

    it('a tick holder with no tier at the tick cap: nothing to buy lifts it', () => {
      const o = limitOffers(
        held({
          productsUsed: TICK_UPLOADS,
          runningTierId: null,
          runningTierProducts: 0,
        }),
        plan,
      );
      expect(o).toEqual({ tiers: [], extraProducts: null });
    });

    it('a small tier under a full tick: one pack or one tier still ends under the tick, so nothing is offered', () => {
      const o = limitOffers(held({ productsUsed: TICK_UPLOADS }), plan);
      expect(o).toEqual({ tiers: [], extraProducts: null });
    });

    it('a tier plus enough extras to beat the tick is offered what lifts it past the tick', () => {
      // Verify (3) + 20 extras = 23 < 25, so the tick (25) is the allowance
      // and 25 are published. One more pack makes 28, which lifts it.
      const o = limitOffers(
        held({
          productsUsed: TICK_UPLOADS,
          extraProducts: 20,
        }),
        plan,
      );
      expect(o.extraProducts).toEqual(plan.extraProducts);
      // Plus (6) + 20 = 26 lifts it too; Verify (3) + 20 = 23 does not.
      expect(ids(o)).toEqual(['plus', 'founding']);
    });
  });

  describe('above the allowance (used is more than allowed)', () => {
    it('the tick ended with 25 up and Verify was bought: nothing lets another go up', () => {
      const o = limitOffers(held({ productsUsed: 25 }), plan);
      expect(o).toEqual({ tiers: [], extraProducts: null });
    });

    it('4 up on Verify: every tier above 4 and the pack (3 + 5 = 8) are offered', () => {
      const o = limitOffers(held({ productsUsed: 4 }), plan);
      expect(ids(o)).toEqual(['plus', 'founding']);
      expect(o.extraProducts).not.toBeNull();
    });

    it('7 up on Verify: Plus (6) is not offered, Founding (10) and the pack (8) are', () => {
      const o = limitOffers(held({ productsUsed: 7 }), plan);
      expect(ids(o)).toEqual(['founding']);
      expect(o.extraProducts).not.toBeNull();
    });

    it('9 up on Verify: only Founding; the pack (8) would still leave fewer than 9', () => {
      const o = limitOffers(held({ productsUsed: 9 }), plan);
      expect(ids(o)).toEqual(['founding']);
      expect(o.extraProducts).toBeNull();
    });

    it('10 up on Verify: no tier is big enough and the pack falls short', () => {
      const o = limitOffers(held({ productsUsed: 10 }), plan);
      expect(o).toEqual({ tiers: [], extraProducts: null });
    });

    it('a tick holder over the tick cap with no tier: nothing', () => {
      const o = limitOffers(
        held({
          productsUsed: 27,
          runningTierId: null,
          runningTierProducts: 0,
        }),
        plan,
      );
      expect(o).toEqual({ tiers: [], extraProducts: null });
    });
  });

  it('extras are never offered without a running tier (the pack is bought on one)', () => {
    const o = limitOffers(
      held({ productsUsed: 2, runningTierId: null, runningTierProducts: 0 }),
      plan,
    );
    expect(o.extraProducts).toBeNull();
  });
});

/**
 * The offers a `tier_required` refusal carries (TIER-02 round 4, D7): the same
 * rule as the limit, one step earlier. A person with no running tier and no
 * tick may still have products up; a tier is offered only if buying it leaves
 * more places than that, and the pack never (it needs a running tier).
 */
describe('tierRequiredOffers', () => {
  const none = (used: number) => ({ productsUsed: used, extraProducts: 0 });

  it("nothing up: every tier, in the plan's order, and no pack", () => {
    const o = tierRequiredOffers(none(0), plan);
    expect(ids(o)).toEqual(['verify', 'plus', 'founding']);
    expect(o.extraProducts).toBeNull();
  });

  it('a tier is offered only if it leaves more places than products up', () => {
    expect(ids(tierRequiredOffers(none(2), plan))).toEqual([
      'verify',
      'plus',
      'founding',
    ]);
    // 3 up: Verify (3) leaves no place for another.
    expect(ids(tierRequiredOffers(none(3), plan))).toEqual([
      'plus',
      'founding',
    ]);
    expect(ids(tierRequiredOffers(none(5), plan))).toEqual([
      'plus',
      'founding',
    ]);
    expect(ids(tierRequiredOffers(none(6), plan))).toEqual(['founding']);
    expect(ids(tierRequiredOffers(none(9), plan))).toEqual(['founding']);
  });

  it('10 up and more: no tier is offered and the pack is not either', () => {
    for (const used of [10, 12, 25])
      expect(tierRequiredOffers(none(used), plan)).toEqual({
        tiers: [],
        extraProducts: null,
      });
  });

  it('extras that would carry over count toward a tier, like the limit offers', () => {
    // Plus (6) + 5 = 11 leaves a place over 9 up; Verify (3) + 5 = 8 does not.
    const o = tierRequiredOffers({ productsUsed: 9, extraProducts: 5 }, plan);
    expect(ids(o)).toEqual(['plus', 'founding']);
  });

  it('judges a tier exactly as the limit offers do', () => {
    for (let used = 0; used <= 12; used += 1) {
      const required = tierRequiredOffers(none(used), plan);
      const limit = limitOffers(
        held({
          productsUsed: used,
          runningTierId: null,
          runningTierProducts: 0,
        }),
        plan,
      );
      expect(ids(required)).toEqual(ids(limit));
    }
  });
});
