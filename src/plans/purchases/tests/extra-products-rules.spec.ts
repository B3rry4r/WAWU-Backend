import { INT4_MAX, loadPlansConfig } from '../../plans-config';
import type { HeldTier } from '../../maker-tier.service';
import {
  extraGoodsFromJson,
  extraGoodsFromTerms,
  extraGoodsOf,
  extraGoodsToTerms,
} from '../extra-products-goods';
import {
  EXTRA_PRODUCTS_TITLE,
  EXTRA_PRODUCTS_TOO_MANY_MESSAGE,
  TIER_ENDED_MESSAGE,
  TIER_REQUIRED_MESSAGE,
  priceExtraProducts,
} from '../extra-products-rules';
import { PurchaseRefusal } from '../plan-purchase-rules';
import {
  EXTRA_PRODUCTS_KIND,
  EXTRA_PRODUCTS_TARGET_ID,
  PURCHASE_PAYMENT_KINDS,
  isExtraProducts,
} from '../plan-purchase-terms';

/**
 * The extra products rules (TIER-04): pure, from the checked config. Every
 * figure is read from the config; none is written in a case.
 */

const config = loadPlansConfig();
const held = (
  state: HeldTier['state'],
  extraProducts = 0,
  productsAllowed = 3,
): Pick<HeldTier, 'state' | 'extraProducts' | 'productsAllowed'> => ({
  state,
  extraProducts,
  productsAllowed,
});
const refusal = (fn: () => unknown): PurchaseRefusal => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PurchaseRefusal);
    return e as PurchaseRefusal;
  }
  throw new Error('expected a refusal');
};

describe('priceExtraProducts', () => {
  it('prices the add-on from the config in the billing currency and says how many places the person has now and would have', () => {
    const naira = priceExtraProducts(config, 'NGN', held('active', 0, 3));
    expect(naira).toEqual({
      currency: 'NGN',
      priceMinor: config.extraProducts.price.kobo,
      products: config.extraProducts.count,
      productsAllowed: 3,
      productsAllowedAfter: 3 + config.extraProducts.count,
    });
    const dollars = priceExtraProducts(config, 'USD', held('active'));
    expect(dollars).toMatchObject({
      currency: 'USD',
      priceMinor: config.extraProducts.price.cents,
    });
  });

  it('follows a changed count and price: nothing is written in the rule', () => {
    const other = {
      ...config,
      extraProducts: {
        count: config.extraProducts.count + 4,
        price: { kobo: 777_700, cents: 999 },
      },
    };
    expect(priceExtraProducts(other, 'NGN', held('ending', 5, 8))).toEqual({
      currency: 'NGN',
      priceMinor: 777_700,
      products: config.extraProducts.count + 4,
      productsAllowed: 8,
      productsAllowedAfter: 8 + config.extraProducts.count + 4,
    });
  });

  it('is sold on a tier that is running (active or ending) and on no other state', () => {
    expect(() =>
      priceExtraProducts(config, 'NGN', held('active')),
    ).not.toThrow();
    expect(() =>
      priceExtraProducts(config, 'NGN', held('ending')),
    ).not.toThrow();
    const none = refusal(() => priceExtraProducts(config, 'NGN', held('none')));
    expect(none.code).toBe('tier_required');
    expect(none.message).toBe(TIER_REQUIRED_MESSAGE);
    const ended = refusal(() =>
      priceExtraProducts(config, 'NGN', held('ended', 5, 0)),
    );
    expect(ended.code).toBe('tier_required');
    expect(ended.message).toBe(TIER_ENDED_MESSAGE);
  });

  it('is not sold when the total would not fit the tier row', () => {
    const r = refusal(() =>
      priceExtraProducts(
        config,
        'NGN',
        held('active', INT4_MAX - config.extraProducts.count + 1),
      ),
    );
    expect(r.code).toBe('target_not_payable');
    expect(r.message).toBe(EXTRA_PRODUCTS_TOO_MANY_MESSAGE);
    expect(() =>
      priceExtraProducts(
        config,
        'NGN',
        held('active', INT4_MAX - config.extraProducts.count),
      ),
    ).not.toThrow();
  });

  it('names the payment and every refusal with no figure and no long dash', () => {
    const long = /[\u2013\u2014]/;
    for (const text of [
      EXTRA_PRODUCTS_TITLE,
      TIER_REQUIRED_MESSAGE,
      TIER_ENDED_MESSAGE,
      EXTRA_PRODUCTS_TOO_MANY_MESSAGE,
    ]) {
      expect(text).not.toMatch(long);
      expect(text).not.toMatch(/\d/);
    }
  });
});

describe('the extra products in a payment target', () => {
  it('is one add-on, read back only for its own kind', () => {
    expect(isExtraProducts(EXTRA_PRODUCTS_KIND, EXTRA_PRODUCTS_TARGET_ID)).toBe(
      true,
    );
    expect(isExtraProducts(EXTRA_PRODUCTS_KIND, 'extra-products-2')).toBe(
      false,
    );
    expect(isExtraProducts('points_pack', EXTRA_PRODUCTS_TARGET_ID)).toBe(
      false,
    );
    expect(isExtraProducts('tier', EXTRA_PRODUCTS_TARGET_ID)).toBe(false);
  });

  it('is a kind the purchase routes and the transfer orders take', () => {
    expect(PURCHASE_PAYMENT_KINDS).toContain(EXTRA_PRODUCTS_KIND);
  });
});

describe('the goods an extra products quote is bound to', () => {
  const plan = priceExtraProducts(config, 'NGN', held('active'));

  it('round-trip through the payment terms', () => {
    const goods = extraGoodsOf(plan);
    expect(goods).toEqual({ products: config.extraProducts.count });
    const terms = extraGoodsToTerms(goods);
    expect(extraGoodsFromTerms(terms)).toEqual(goods);
    expect(extraGoodsFromJson(JSON.parse(JSON.stringify(terms)))).toEqual(
      goods,
    );
  });

  it('a missing, foreign or damaged terms object is an error, never a guess', () => {
    expect(() => extraGoodsFromTerms(undefined)).toThrow();
    expect(() => extraGoodsFromJson(null)).toThrow();
    expect(() => extraGoodsFromTerms({ v: 2, products: 5 })).toThrow();
    expect(() => extraGoodsFromTerms({ v: 1 })).toThrow();
    expect(() => extraGoodsFromTerms({ v: 1, products: 0 })).toThrow();
    expect(() => extraGoodsFromTerms({ v: 1, products: 2.5 })).toThrow();
    expect(() => extraGoodsFromTerms({ v: 1, products: '5' })).toThrow();
    // A points pack's terms are not extra products terms.
    expect(() =>
      extraGoodsFromTerms({ v: 1, packId: 's', points: 10, bonusPoints: 0 }),
    ).toThrow();
  });
});
