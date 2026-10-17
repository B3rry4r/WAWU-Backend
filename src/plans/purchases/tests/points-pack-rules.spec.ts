import { INT4_MAX, loadPlansConfig, percentOf } from '../../plans-config';
import type { HeldTier } from '../../maker-tier.service';
import { PurchaseRefusal } from '../plan-purchase-rules';
import { packIdOf, packTargetIdOf } from '../plan-purchase-terms';
import {
  packGoodsFromJson,
  packGoodsFromTerms,
  packGoodsOf,
  packGoodsToTerms,
} from '../points-pack-goods';
import {
  PACK_NOT_FOUND_MESSAGE,
  PACK_TOO_BIG_MESSAGE,
  packBonusPercentOf,
  packTitle,
  pricePack,
} from '../points-pack-rules';

/**
 * The points pack rules (POINTS-02): pure, from the checked config. Every
 * figure is read from the config; none is written in a case.
 */

const config = loadPlansConfig();
const pack = config.packs[0];
const founding = config.tiers.find((t) => t.packBonusPct > 0)!;
const plain = config.tiers.find((t) => t.packBonusPct === 0)!;
const held = (
  state: HeldTier['state'],
  tier: HeldTier['tier'],
): Pick<HeldTier, 'state' | 'tier'> => ({ state, tier });

describe('percentOf', () => {
  it('rounds down to a whole point', () => {
    expect(percentOf(1000, 10)).toBe(100);
    expect(percentOf(1005, 10)).toBe(100);
    expect(percentOf(999, 10)).toBe(99);
    expect(percentOf(9, 10)).toBe(0);
    expect(percentOf(1, 100)).toBe(1);
    expect(percentOf(123_456, 0)).toBe(0);
    expect(percentOf(INT4_MAX, 100)).toBe(INT4_MAX);
    expect(percentOf(INT4_MAX, 33)).toBe(Math.floor((INT4_MAX * 33) / 100));
  });
});

describe('pricePack', () => {
  it('prices a pack from the config in the billing currency, with no bonus for a person with no tier', () => {
    const naira = pricePack(config, 'NGN', held('none', null), pack.id);
    expect(naira).toMatchObject({
      priceMinor: pack.price.kobo,
      points: pack.points.NGN,
      bonusPercent: 0,
      bonusPoints: 0,
      totalPoints: pack.points.NGN,
      boughtExpiryDays: config.points.boughtExpiryDays,
      currency: 'NGN',
    });
    const dollars = pricePack(config, 'USD', held('none', null), pack.id);
    expect(dollars).toMatchObject({
      priceMinor: pack.price.cents,
      points: pack.points.USD,
      currency: 'USD',
    });
  });

  it('adds the tier percent while the tier runs (active or ending), rounded down; an ended tier or a tier with none adds nothing', () => {
    for (const state of ['active', 'ending'] as const) {
      const plan = pricePack(config, 'NGN', held(state, founding), pack.id);
      expect(plan.bonusPercent).toBe(founding.packBonusPct);
      expect(plan.bonusPoints).toBe(
        percentOf(pack.points.NGN, founding.packBonusPct),
      );
      expect(plan.totalPoints).toBe(plan.points + plan.bonusPoints);
    }
    expect(
      pricePack(config, 'NGN', held('ended', founding), pack.id).bonusPoints,
    ).toBe(0);
    expect(
      pricePack(config, 'NGN', held('active', plain), pack.id).bonusPoints,
    ).toBe(0);
    expect(packBonusPercentOf(held('active', null))).toBe(0);
  });

  it('rounds a half point down', () => {
    const odd = {
      ...config,
      packs: [{ ...pack, points: { NGN: 1005, USD: 1005 } }],
    };
    expect(
      pricePack(odd, 'NGN', held('active', founding), pack.id),
    ).toMatchObject({ bonusPoints: 100, totalPoints: 1105 });
  });

  it('refuses a pack the file does not name, and a pack and bonus too big for one lot', () => {
    expect(() =>
      pricePack(config, 'NGN', held('none', null), 'nonesuch'),
    ).toThrow(
      expect.objectContaining({
        code: 'target_not_found',
        message: PACK_NOT_FOUND_MESSAGE,
      }) as PurchaseRefusal,
    );
    const huge = {
      ...config,
      packs: [{ ...pack, points: { NGN: INT4_MAX, USD: INT4_MAX } }],
    };
    expect(() =>
      pricePack(huge, 'NGN', held('active', founding), pack.id),
    ).toThrow(
      expect.objectContaining({
        code: 'target_not_payable',
        message: PACK_TOO_BIG_MESSAGE,
      }) as PurchaseRefusal,
    );
    // Without the bonus the same pack fits.
    expect(
      pricePack(huge, 'NGN', held('none', null), pack.id).totalPoints,
    ).toBe(INT4_MAX);
  });

  it('names the payment with no figure and no long dash', () => {
    const title = packTitle(
      pricePack(config, 'NGN', held('none', null), pack.id),
    );
    expect(title).toBe(`Points pack ${pack.id.toUpperCase()}`);
    expect(title).not.toMatch(/\d|\u2014|\u2013/);
    expect(PACK_NOT_FOUND_MESSAGE + PACK_TOO_BIG_MESSAGE).not.toMatch(
      /\u2014|\u2013/,
    );
  });
});

describe('a pack in a payment target', () => {
  it('is pack-<id>, read back only for the points_pack kind', () => {
    expect(packTargetIdOf('s')).toBe('pack-s');
    expect(packIdOf('points_pack', 'pack-s')).toBe('s');
    expect(packIdOf('points_pack', 'pack-big_one2')).toBe('big_one2');
    expect(packIdOf('tier', 'pack-s')).toBeNull();
    expect(packIdOf('points_pack', 'tier-founding')).toBeNull();
    expect(packIdOf('points_pack', 'pack-')).toBeNull();
    expect(packIdOf('points_pack', 'pack-S')).toBeNull();
    expect(packTargetIdOf('Bad-Id')).toBeNull();
    expect(packTargetIdOf('a'.repeat(80))).toBeNull();
  });
});

describe('the goods a pack quote is bound to', () => {
  const plan = pricePack(config, 'NGN', held('active', founding), pack.id);
  it('round-trip through the payment terms', () => {
    const goods = packGoodsOf(plan);
    expect(goods).toEqual({
      packId: pack.id,
      points: plan.points,
      bonusPoints: plan.bonusPoints,
      boughtExpiryDays: config.points.boughtExpiryDays,
    });
    const terms = packGoodsToTerms(goods);
    expect(packGoodsFromTerms(terms)).toEqual(goods);
    expect(packGoodsFromJson(JSON.parse(JSON.stringify(terms)))).toEqual(goods);
  });
  it('a missing, foreign or damaged terms object is an error, never a guess', () => {
    const terms = packGoodsToTerms(packGoodsOf(plan));
    expect(() => packGoodsFromTerms(undefined)).toThrow(/no terms/);
    expect(() => packGoodsFromJson(null)).toThrow();
    expect(() => packGoodsFromTerms({ ...terms, v: 2 })).toThrow(/version/);
    expect(() => packGoodsFromTerms({ ...terms, points: 0 })).toThrow(/points/);
    expect(() => packGoodsFromTerms({ ...terms, points: 1.5 })).toThrow(
      /points/,
    );
    expect(() => packGoodsFromTerms({ ...terms, bonusPoints: -1 })).toThrow(
      /bonusPoints/,
    );
    expect(() => packGoodsFromTerms({ ...terms, boughtExpiryDays: 0 })).toThrow(
      /boughtExpiryDays/,
    );
    expect(() => packGoodsFromTerms({ ...terms, packId: '' })).toThrow(
      /packId/,
    );
  });
});
