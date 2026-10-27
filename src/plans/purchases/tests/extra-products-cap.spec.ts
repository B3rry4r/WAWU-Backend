import { limitOffers } from '../../limit-offers';
import { loadPlansConfig, type PlansConfig } from '../../plans-config';
import type { PlanTierView } from '../../plans-view.type';
import {
  PACK_NOT_ALLOWED_CODE,
  PACK_AT_MOST_MESSAGE,
  PACK_TIER_MESSAGE,
  packLiftsLimit,
  packRefusalFor,
  packRuleOf,
} from '../extra-products-cap';
import { priceExtraProducts } from '../extra-products-rules';
import { PurchaseRefusal } from '../plan-purchase-rules';

/**
 * PACK-CAP (R-100): the "Add 5 more products" pack is sold only on a tier the
 * settings name (Founding Maker by default), and at most `max_packs` of them.
 * Pure: the rule, the price check and the offers a full profile is shown.
 */

const base = loadPlansConfig();
const withRule = (tiers: string[], maxPacks: number): PlansConfig => ({
  ...base,
  extraProducts: { ...base.extraProducts, tiers, maxPacks },
});
const SEED = withRule(['founding'], 2);
const COUNT = base.extraProducts.count;
const running = (tierId: string, extraProducts: number, included: number) => ({
  state: 'active' as const,
  tierId,
  extraProducts,
  productsAllowed: included + extraProducts,
});

describe('the pack rule (R-100)', () => {
  it('reads the tiers and the most packs from the settings; a missing setting sells nothing', () => {
    expect(packRuleOf(SEED)).toEqual({
      tiers: ['founding'],
      maxPacks: 2,
      count: COUNT,
    });
    expect(packRuleOf(base)).toEqual({ tiers: [], maxPacks: 0, count: COUNT });
    expect(packRefusalFor(packRuleOf(base), 'founding', 0)).toBe('tier');
  });

  it('Verify and Verify Plus are refused on the tier; Founding Maker gets two packs and then nothing', () => {
    const rule = packRuleOf(SEED);
    expect(packRefusalFor(rule, 'verify', 0)).toBe('tier');
    expect(packRefusalFor(rule, 'plus', 0)).toBe('tier');
    expect(packRefusalFor(rule, null, 0)).toBe('tier');
    expect(packRefusalFor(rule, 'founding', 0)).toBeNull();
    expect(packRefusalFor(rule, 'founding', COUNT)).toBeNull();
    expect(packRefusalFor(rule, 'founding', 2 * COUNT)).toBe('max');
    // Packs bought before the rule stay as they were: three held, no fourth.
    expect(packRefusalFor(rule, 'founding', 3 * COUNT)).toBe('max');
  });

  it('the settings change the rule: more tiers, more packs, or none', () => {
    expect(
      packRefusalFor(packRuleOf(withRule(['plus', 'founding'], 2)), 'plus', 0),
    ).toBeNull();
    expect(
      packRefusalFor(
        packRuleOf(withRule(['founding'], 3)),
        'founding',
        2 * COUNT,
      ),
    ).toBeNull();
    expect(
      packRefusalFor(packRuleOf(withRule(['founding'], 1)), 'founding', COUNT),
    ).toBe('max');
    expect(
      packRefusalFor(packRuleOf(withRule(['founding'], 0)), 'founding', 0),
    ).toBe('max');
    expect(packRefusalFor(packRuleOf(withRule([], 2)), 'founding', 0)).toBe(
      'tier',
    );
  });
});

describe('pricing the pack under the rule', () => {
  it('refuses a running Verify or Verify Plus with pack_not_allowed, in words with no figure and no em-dash', () => {
    for (const id of ['verify', 'plus']) {
      let caught: unknown;
      try {
        priceExtraProducts(SEED, 'NGN', running(id, 0, 3));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PurchaseRefusal);
      expect((caught as PurchaseRefusal).code).toBe(PACK_NOT_ALLOWED_CODE);
      expect((caught as PurchaseRefusal).message).toBe(PACK_TIER_MESSAGE);
    }
    expect(PACK_NOT_ALLOWED_CODE).toBe('pack_not_allowed');
    for (const m of [PACK_TIER_MESSAGE, PACK_AT_MOST_MESSAGE])
      expect(m).not.toMatch(/[–—]/);
    expect(PACK_AT_MOST_MESSAGE).toBe(
      "That's the most products a profile can hold.",
    );
  });

  it('prices the first and the second pack for Founding Maker, and refuses the third', () => {
    expect(
      priceExtraProducts(SEED, 'NGN', running('founding', 0, 10)),
    ).toMatchObject({ products: COUNT, productsAllowed: 10 });
    expect(
      priceExtraProducts(SEED, 'NGN', running('founding', COUNT, 10)),
    ).toMatchObject({ productsAllowedAfter: 10 + 2 * COUNT });
    expect(() =>
      priceExtraProducts(SEED, 'NGN', running('founding', 2 * COUNT, 10)),
    ).toThrow(PACK_AT_MOST_MESSAGE);
  });

  it('still answers tier_required first when there is no running tier', () => {
    try {
      priceExtraProducts(SEED, 'NGN', {
        state: 'none',
        tierId: null,
        extraProducts: 0,
        productsAllowed: 0,
      });
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PurchaseRefusal).code).toBe('tier_required');
    }
  });
});

describe('the offers a full profile is shown', () => {
  const tier = (id: string, products: number) =>
    ({ id, products }) as unknown as PlanTierView;
  const plan = {
    tiers: [tier('verify', 3), tier('plus', 6), tier('founding', 10)],
    extraProducts: { count: COUNT, priceMinor: 150_000 },
  };
  const rule = packRuleOf(SEED);
  const full = (id: string, included: number, extra: number) => ({
    productsUsed: included + extra,
    runningTierId: id,
    runningTierProducts: included,
    extraProducts: extra,
  });

  it('Verify and Verify Plus are offered tiers only, never the pack', () => {
    const v = limitOffers(full('verify', 3, 0), plan, rule);
    expect(v.tiers.map((t) => t.id)).toEqual(['plus', 'founding']);
    expect(v.extraProducts).toBeNull();
    const p = limitOffers(full('plus', 6, 0), plan, rule);
    expect(p.tiers.map((t) => t.id)).toEqual(['founding']);
    expect(p.extraProducts).toBeNull();
  });

  it('Founding Maker is offered the pack at 10 of 10 and at 15 of 15, and nothing at 20 of 20', () => {
    expect(
      limitOffers(full('founding', 10, 0), plan, rule).extraProducts,
    ).toEqual(plan.extraProducts);
    expect(
      limitOffers(full('founding', 10, COUNT), plan, rule).extraProducts,
    ).toEqual(plan.extraProducts);
    const end = limitOffers(full('founding', 10, 2 * COUNT), plan, rule);
    expect(end.extraProducts).toBeNull();
    expect(end.tiers).toEqual([]);
  });

  it('a settings change opens the pack to Verify again', () => {
    const open = packRuleOf(withRule(['verify', 'plus', 'founding'], 2));
    expect(limitOffers(full('verify', 3, 0), plan, open).extraProducts).toEqual(
      plan.extraProducts,
    );
  });
});

describe('the pack must lift the limit above what is published', () => {
  it('lifts it only when places plus the pack are more than the products published', () => {
    expect(packLiftsLimit(3, COUNT, 3)).toBe(true);
    expect(packLiftsLimit(3, COUNT, 7)).toBe(true);
    expect(packLiftsLimit(3, COUNT, 8)).toBe(false);
    expect(packLiftsLimit(3, COUNT, 12)).toBe(false);
    expect(packLiftsLimit(0, COUNT, 0)).toBe(true);
    expect(packLiftsLimit(20, 0, 20)).toBe(false);
  });
});
