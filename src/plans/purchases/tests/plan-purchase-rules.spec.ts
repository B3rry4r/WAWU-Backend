import type { MyTierState } from '../../plans-view.type';
import type { HeldTier } from '../../maker-tier.service';
import {
  countIn,
  loadPlansConfig,
  priceIn,
  tierById,
  type PlanTier,
} from '../../plans-config';
import {
  CANNOT_PRICE_UPGRADE_MESSAGE,
  NO_DOWNGRADE_MESSAGE,
  NOTHING_TO_RENEW_MESSAGE,
  NOTHING_TO_UPGRADE_MESSAGE,
  PLAN_CHANGED_MESSAGE,
  PLAN_NOT_FOUND_MESSAGE,
  PLAN_RUNNING_MESSAGE,
  planPurchase,
  PurchaseRefusal,
  purchaseTitle,
  RENEW_SAME_PLAN_MESSAGE,
  SAME_PLAN_MESSAGE,
} from '../plan-purchase-rules';
import type { PurchaseTerms } from '../plan-purchase-terms';

/**
 * TIER-03: what a person may buy and what it costs. Every expected figure is
 * read from the config the code reads, so a changed figure changes both.
 */

const config = loadPlansConfig();
const byPrice = [...config.tiers].sort((a, b) => a.price.kobo - b.price.kobo);
const small = byPrice[0];
const middle = byPrice[1];
const big = byPrice[byPrice.length - 1];

const held = (
  state: MyTierState,
  tier: PlanTier | null,
  tierId: string | null = tier?.id ?? null,
): Pick<HeldTier, 'state' | 'tierId' | 'tier'> => ({ state, tierId, tier });
const none = held('none', null);

const terms = (
  kind: 'tier' | 'renew' | 'upgrade',
  tierId: string,
  over: Partial<PurchaseTerms> = {},
): PurchaseTerms => ({ kind, tierId, fromTierId: null, bump: false, ...over });

const refused = (fn: () => unknown, code: string, message: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PurchaseRefusal);
    expect((e as PurchaseRefusal).code).toBe(code);
    expect((e as PurchaseRefusal).message).toBe(message);
    return;
  }
  throw new Error(`expected a refusal: ${message}`);
};

describe('what a tier purchase costs (TIER-03)', () => {
  it('has three tiers, cheapest first, to test with', () => {
    expect(config.tiers.length).toBeGreaterThanOrEqual(3);
    expect(small.price.kobo).toBeLessThan(middle.price.kobo);
    expect(middle.price.kobo).toBeLessThan(big.price.kobo);
  });

  it.each(['NGN', 'USD'] as const)(
    'prices a first purchase at the tier price in %s',
    (currency) => {
      for (const tier of config.tiers) {
        const plan = planPurchase(
          config,
          currency,
          none,
          terms('tier', tier.id),
        );
        expect(plan.planMinor).toBe(priceIn(tier.price, currency));
        expect(plan.bumpMinor).toBe(0);
        expect(plan.bumpPoints).toBe(0);
        expect(plan.totalMinor).toBe(plan.planMinor);
        expect(plan.currency).toBe(currency);
        expect(plan.fromTier).toBeNull();
      }
    },
  );

  it.each(['NGN', 'USD'] as const)(
    'adds the checkout bump price and points in %s',
    (currency) => {
      const plan = planPurchase(
        config,
        currency,
        none,
        terms('tier', big.id, { bump: true }),
      );
      expect(plan.bumpMinor).toBe(priceIn(config.checkoutBump.price, currency));
      expect(plan.bumpPoints).toBe(
        countIn(config.checkoutBump.points, currency),
      );
      expect(plan.totalMinor).toBe(plan.planMinor + plan.bumpMinor);
    },
  );

  it('allows a first purchase after the last tier ended, of any tier', () => {
    for (const tier of config.tiers)
      expect(
        planPurchase(
          config,
          'NGN',
          held('ended', small),
          terms('tier', tier.id),
        ).planMinor,
      ).toBe(tier.price.kobo);
  });

  it('refuses a first purchase while a tier runs (active or ending)', () => {
    for (const state of ['active', 'ending'] as const)
      refused(
        () =>
          planPurchase(
            config,
            'NGN',
            held(state, small),
            terms('tier', big.id),
          ),
        'target_not_payable',
        PLAN_RUNNING_MESSAGE,
      );
  });

  it('renews the tier held, in any state, at its price', () => {
    for (const state of ['active', 'ending', 'ended'] as const) {
      const plan = planPurchase(
        config,
        'NGN',
        held(state, middle),
        terms('renew', middle.id),
      );
      expect(plan.planMinor).toBe(middle.price.kobo);
    }
  });

  it('refuses a renewal with nothing to renew, or of another tier', () => {
    refused(
      () => planPurchase(config, 'NGN', none, terms('renew', small.id)),
      'target_not_payable',
      NOTHING_TO_RENEW_MESSAGE,
    );
    refused(
      () =>
        planPurchase(
          config,
          'NGN',
          held('active', small),
          terms('renew', big.id),
        ),
      'target_not_payable',
      RENEW_SAME_PLAN_MESSAGE,
    );
  });

  it.each(['NGN', 'USD'] as const)(
    'prices an upgrade at the difference of the two prices in %s',
    (currency) => {
      const plan = planPurchase(
        config,
        currency,
        held('active', small),
        terms('upgrade', big.id, { fromTierId: small.id }),
      );
      expect(plan.planMinor).toBe(
        priceIn(big.price, currency) - priceIn(small.price, currency),
      );
      expect(plan.fromTier?.id).toBe(small.id);
      const ending = planPurchase(
        config,
        currency,
        held('ending', middle),
        terms('upgrade', big.id, { fromTierId: middle.id, bump: true }),
      );
      expect(ending.totalMinor).toBe(
        priceIn(big.price, currency) -
          priceIn(middle.price, currency) +
          priceIn(config.checkoutBump.price, currency),
      );
    },
  );

  it('refuses an upgrade that cannot apply', () => {
    const up = (from: string, to: string) =>
      terms('upgrade', to, { fromTierId: from });
    refused(
      () => planPurchase(config, 'NGN', none, up(small.id, big.id)),
      'target_not_payable',
      NOTHING_TO_UPGRADE_MESSAGE,
    );
    refused(
      () =>
        planPurchase(config, 'NGN', held('ended', small), up(small.id, big.id)),
      'target_not_payable',
      NOTHING_TO_UPGRADE_MESSAGE,
    );
    refused(
      () =>
        planPurchase(
          config,
          'NGN',
          held('active', middle),
          up(small.id, big.id),
        ),
      'target_not_payable',
      PLAN_CHANGED_MESSAGE,
    );
    refused(
      () =>
        planPurchase(
          config,
          'NGN',
          held('active', small),
          up(small.id, small.id),
        ),
      'target_not_payable',
      SAME_PLAN_MESSAGE,
    );
    refused(
      () =>
        planPurchase(config, 'NGN', held('active', big), up(big.id, small.id)),
      'target_not_payable',
      NO_DOWNGRADE_MESSAGE,
    );
    refused(
      () =>
        planPurchase(
          config,
          'NGN',
          held('active', null, 'retired_tier'),
          up('retired_tier', big.id),
        ),
      'target_not_payable',
      CANNOT_PRICE_UPGRADE_MESSAGE,
    );
  });

  it('knows no tier the config does not name', () => {
    refused(
      () => planPurchase(config, 'NGN', none, terms('tier', 'nope')),
      'target_not_found',
      PLAN_NOT_FOUND_MESSAGE,
    );
    expect(tierById(config, 'nope')).toBeNull();
  });

  it('titles a payment with the tier name and no figure', () => {
    const t = (k: 'tier' | 'renew' | 'upgrade', bump: boolean) =>
      purchaseTitle(
        planPurchase(
          config,
          'NGN',
          k === 'tier' ? none : held('active', small),
          k === 'upgrade'
            ? terms(k, big.id, { fromTierId: small.id, bump })
            : terms(k, k === 'renew' ? small.id : big.id, { bump }),
        ),
      );
    expect(t('tier', false)).toBe(big.name);
    expect(t('tier', true)).toBe(`${big.name} and bonus points`);
    expect(t('renew', false)).toBe(`${small.name} renewal`);
    expect(t('upgrade', false)).toBe(`Upgrade to ${big.name}`);
    for (const k of ['tier', 'renew', 'upgrade'] as const)
      expect(t(k, true)).not.toMatch(/[0-9—₦$]/);
  });
});
