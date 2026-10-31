import { buildRegistry, LONG_DASH } from '../plan-setting-registry';
import { loadPlanSettingsDefaults } from '../plan-settings-defaults';

/**
 * HUB-SWEEP-1 (F3 of the 31 Oct 2026 walk): the products each tier allows (Verify 4, Verify Plus 8, Founding Maker 15)
 * were still marked "the owner did not name this figure" on the settings list. R-112 (owner, 27 Oct 2026) names them.
 * The note now cites R-112; the figures themselves are what they were.
 */
const seed = loadPlanSettingsDefaults();
const defs = buildRegistry(seed.plans, seed.extras);
const def = (key: string) => defs.find((d) => d.key === key)!;

describe('the tier product counts carry the R-112 note, not the board note (HUB-SWEEP-1)', () => {
  it.each([
    ['verify', 4],
    ['plus', 8],
    ['founding', 15],
  ])(
    'plan.tier.%s.products is %i and its note cites R-112',
    (tier, products) => {
      const d = def(`plan.tier.${tier}.products`);
      expect(d.default).toBe(products);
      expect(d.provisional).toBe('TIER-PRODUCTS');
      const why = seed.extras.provisional[d.provisional!];
      expect(why).toContain('R-112');
      expect(why).not.toContain('did not name');
      expect(why).not.toMatch(LONG_DASH);
    },
  );

  it('the plan file no longer says the products are example values', () => {
    expect(seed.plans.provisional['PLAN-PRICES']).toContain('R-112');
  });

  it('the other board figures keep the board note', () => {
    expect(def('plan.pack.m.price_kobo').provisional).toBe('DV2-BOARD-FIGURE');
    expect(def('plan.tier.verify.bonus_points').provisional).toBe(
      'DV2-BOARD-FIGURE',
    );
  });
});
