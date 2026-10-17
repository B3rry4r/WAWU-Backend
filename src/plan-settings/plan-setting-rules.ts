import {
  percentOf,
  type PlanTier,
  type PlansConfig,
} from '../plans/plans-config';

/**
 * Rules that tie two or more settings together (TIER-06 round 2). One rule
 * today: points are never cashed out for more than they are sold for.
 *
 * A person can buy points (a pack, the checkout offer, or a shortfall paid
 * from the wallet) and later turn them into wallet cash. If the cash paid for
 * 1,000 points were above what 1,000 points cost, buying and cashing out
 * would make money at WAWU's cost. So the cash rate may not exceed the price
 * per point of ANY way points are sold; the cheapest decides.
 *
 * A Founding Maker is sold the pack's points and the tier's extra percent on
 * top (`plan.tier.<id>.pack_bonus_pct`, rounded down to a whole point, POINTS-02),
 * so a pack's points in this rule are the most any buyer gets for its price:
 * the pack's points plus the largest bonus of any tier.
 *
 * Pure: a plan in, the first breach out. The service checks the plan a change
 * would produce, so the order in which an admin changes the settings does not
 * matter, and a request that moves both at once is judged on the pair.
 */

/** The setting that says what 1,000 points pay into the wallet. */
export const CASH_RATE_KEY = 'points.cash_rate_kobo_per_1000';

/** One way points are bought with naira, and the settings that fix its price. */
export interface PointsSale {
  /** In words, for the message. */
  label: string;
  /** The setting holding the price, in kobo. */
  priceKey: string;
  /** The setting holding how many points the price buys; null when the price is per 1,000. */
  pointsKey: string | null;
  priceKobo: number;
  /** The points the price buys; for a pack, the most any buyer gets (the tier's bonus counted). */
  points: number;
  /** What the points include beyond the pack's own: set only when a tier gives extra points on this sale. */
  bonus: {
    /** The pack's own points, before the bonus. */
    basePoints: number;
    percent: number;
    /** The setting holding the percent. */
    key: string;
    /** The tier that gives it. */
    tierName: string;
  } | null;
}

/** The tier that gives the largest bonus on packs (the first in the plan's order among equals), or null when none gives any. */
function largestPackBonus(plan: PlansConfig): PlanTier | null {
  let best: PlanTier | null = null;
  for (const t of plan.tiers)
    if (
      t.packBonusPct > 0 &&
      (best === null || t.packBonusPct > best.packBonusPct)
    )
      best = t;
  return best;
}

/** The setting that holds a tier's extra percent on packs. */
export const packBonusKey = (tierId: string): string =>
  `plan.tier.${tierId}.pack_bonus_pct`;

/** Every way points are sold for naira, in the plan's order. */
export function pointsSales(plan: PlansConfig): PointsSale[] {
  const founding = largestPackBonus(plan);
  return [
    ...plan.packs.map((p): PointsSale => {
      const base = {
        label: `Pack ${p.id.toUpperCase()}`,
        priceKey: `plan.pack.${p.id}.price_kobo`,
        pointsKey: `plan.pack.${p.id}.points`,
        priceKobo: p.price.kobo,
      };
      if (founding === null)
        return { ...base, points: p.points.NGN, bonus: null };
      return {
        ...base,
        points: p.points.NGN + percentOf(p.points.NGN, founding.packBonusPct),
        bonus: {
          basePoints: p.points.NGN,
          percent: founding.packBonusPct,
          key: packBonusKey(founding.id),
          tierName: founding.name,
        },
      };
    }),
    {
      label: 'The checkout offer',
      priceKey: 'plan.checkout_bump.price_kobo',
      pointsKey: 'plan.checkout_bump.points',
      priceKobo: plan.checkoutBump.price.kobo,
      points: plan.checkoutBump.points.NGN,
      bonus: null,
    },
    {
      label: 'Points bought to cover a shortfall',
      priceKey: 'points.price_kobo_per_1000',
      pointsKey: null,
      priceKobo: plan.points.pricePer1000Points.kobo,
      points: 1000,
      bonus: null,
    },
  ];
}

/** The settings that, when they change, can break the rule. */
export function ruleKeys(plan: PlansConfig): Set<string> {
  const keys = new Set<string>([CASH_RATE_KEY]);
  // Any tier's extra percent on packs can become the largest.
  for (const t of plan.tiers) keys.add(packBonusKey(t.id));
  for (const s of pointsSales(plan)) {
    keys.add(s.priceKey);
    if (s.pointsKey !== null) keys.add(s.pointsKey);
  }
  return keys;
}

/** True when `a` sells a point for less than `b` does (exact, no rounding). */
function cheaper(a: PointsSale, b: PointsSale): boolean {
  return (
    BigInt(a.priceKobo) * BigInt(b.points) <
    BigInt(b.priceKobo) * BigInt(a.points)
  );
}

/**
 * The cheapest sale that sells a point for less than the cash rate pays out,
 * or null when the rate is within every sale. Compared exactly: the cash for
 * a sale's points at the rate (rate x points / 1,000) may not exceed its price.
 */
export function cashRateBreach(plan: PlansConfig): PointsSale | null {
  const rate = BigInt(plan.cashOut.per1000Points.kobo);
  let worst: PointsSale | null = null;
  for (const s of pointsSales(plan)) {
    if (rate * BigInt(s.points) > BigInt(s.priceKobo) * 1000n) {
      if (worst === null || cheaper(s, worst)) worst = s;
    }
  }
  return worst;
}

/** The refusal, in words, naming both settings. No long dash. */
export function cashRateBreachMessage(
  plan: PlansConfig,
  sale: PointsSale,
): string {
  const rate = plan.cashOut.per1000Points.kobo;
  const price =
    sale.pointsKey === null
      ? `${sale.priceKey} is ${sale.priceKobo} kobo for each thousand points`
      : sale.bonus === null
        ? `${sale.priceKey} is ${sale.priceKobo} kobo for ${sale.points} points (${sale.pointsKey})`
        : `${sale.priceKey} is ${sale.priceKobo} kobo for ${sale.bonus.basePoints} points (${sale.pointsKey}), and a ${sale.bonus.tierName} buyer gets ${sale.bonus.percent} percent more (${sale.bonus.key}), ${sale.points} points in all`;
  return (
    `${CASH_RATE_KEY} is ${rate} kobo for each thousand points, which is more than ${sale.label} sells points for: ${price}. ` +
    'Cashing points out must never pay more than buying them costs. Lower the cash rate, or raise that price, or change both in one request.'
  );
}
