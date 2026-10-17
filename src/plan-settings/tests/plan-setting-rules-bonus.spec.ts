import {
  loadPlansConfig,
  percentOf,
  type PlansConfig,
} from '../../plans/plans-config';
import {
  cashRateBreach,
  cashRateBreachMessage,
  packBonusKey,
  pointsSales,
  ruleKeys,
} from '../plan-setting-rules';

/**
 * The cash-out rule counts the Founding bonus (TIER-06 round 2, low 2,
 * POINTS-02): a Founding Maker is sold a pack's points plus the tier's extra
 * percent, so a cash rate that fits the pack alone must be refused when it
 * would pay more for those points than the Founding buyer paid. Pure.
 */

const base = loadPlansConfig();
const founding = base.tiers.find((t) => t.packBonusPct > 0)!;

const withRate = (
  plan: PlansConfig,
  kobo: number,
  pct?: number,
): PlansConfig => ({
  ...plan,
  tiers: plan.tiers.map((t) =>
    t.id === founding.id && pct !== undefined ? { ...t, packBonusPct: pct } : t,
  ),
  cashOut: {
    ...plan.cashOut,
    per1000Points: { ...plan.cashOut.per1000Points, kobo },
  },
});

/** The most 1,000 points can pay without any sale selling a point for less, in kobo. */
const ceiling = (plan: PlansConfig) =>
  Math.min(
    ...pointsSales(plan).map((s) =>
      Math.floor((s.priceKobo * 1000) / s.points),
    ),
  );

describe('the cash rate rule with the Founding bonus', () => {
  it('counts the bonus points of every pack, and only of packs', () => {
    const sales = pointsSales(base);
    for (const p of base.packs) {
      const sale = sales.find(
        (s) => s.priceKey === `plan.pack.${p.id}.price_kobo`,
      )!;
      expect(sale.points).toBe(
        p.points.NGN + percentOf(p.points.NGN, founding.packBonusPct),
      );
      expect(sale.bonus).toMatchObject({
        basePoints: p.points.NGN,
        percent: founding.packBonusPct,
        key: packBonusKey(founding.id),
      });
    }
    const bump = sales.find(
      (s) => s.priceKey === 'plan.checkout_bump.price_kobo',
    )!;
    expect(bump.points).toBe(base.checkoutBump.points.NGN);
    expect(bump.bonus).toBeNull();
  });

  it('uses the largest percent of any tier, and no bonus when none gives one', () => {
    const none = withRate(base, base.cashOut.per1000Points.kobo, 0);
    expect(pointsSales(none).every((s) => s.bonus === null)).toBe(true);
    const bigger = {
      ...base,
      tiers: base.tiers.map((t, i) => ({
        ...t,
        packBonusPct: i === 0 ? 40 : t.packBonusPct,
      })),
    };
    const sale = pointsSales(bigger)[0];
    expect(sale.bonus!.percent).toBe(40);
    expect(sale.bonus!.key).toBe(packBonusKey(bigger.tiers[0].id));
  });

  it('refuses a rate that fits the packs alone but pays more than a Founding buyer paid', () => {
    const plain = Math.min(
      ...base.packs.map((p) =>
        Math.floor((p.price.kobo * 1000) / p.points.NGN),
      ),
      Math.floor(
        (base.checkoutBump.price.kobo * 1000) / base.checkoutBump.points.NGN,
      ),
      base.points.pricePer1000Points.kobo,
    );
    const exact = ceiling(base);
    expect(exact).toBeLessThan(plain);
    // The old rule (no bonus) would have allowed `plain`; the bonus lowers it.
    expect(cashRateBreach(withRate(base, plain))).not.toBeNull();
    expect(cashRateBreach(withRate(base, exact))).toBeNull();
    expect(cashRateBreach(withRate(base, exact + 1))).not.toBeNull();
  });

  it('says which bonus did it, naming the percent setting and both figures, with no long dash', () => {
    const plan = withRate(base, ceiling(base) + 1000);
    const sale = cashRateBreach(plan)!;
    expect(sale.bonus).not.toBeNull();
    const text = cashRateBreachMessage(plan, sale);
    expect(text).toContain(packBonusKey(founding.id));
    expect(text).toContain(sale.priceKey);
    expect(text).toContain(`${founding.packBonusPct} percent more`);
    expect(text).toContain(`${sale.points} points in all`);
    expect(text).not.toMatch(/\u2014|\u2013/);
  });

  it('a change of any tier percent is judged by the rule', () => {
    const keys = ruleKeys(base);
    for (const t of base.tiers) expect(keys.has(packBonusKey(t.id))).toBe(true);
    // Raising the percent at a rate that sat on the ceiling breaches it.
    const rate = ceiling(base);
    expect(cashRateBreach(withRate(base, rate))).toBeNull();
    expect(cashRateBreach(withRate(base, rate, 90))).not.toBeNull();
  });
});
