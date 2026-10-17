import type { BillingCurrency } from '../../../generated/prisma/enums';
import type { HeldTier } from '../maker-tier.service';
import {
  countIn,
  INT4_MAX,
  percentOf,
  priceIn,
  type PlanPack,
  type PlansConfig,
} from '../plans-config';
import { isRunning, PurchaseRefusal } from './plan-purchase-rules';

/**
 * What a points pack costs and gives (POINTS-02, PT4). Pure: the config, the
 * billing currency and what the person holds in, a priced pack or a refusal
 * out. Every figure is read from the checked config (`priceIn`, `countIn`),
 * which is the live plan the admin settings lay over the file (TIER-06, R-65);
 * none is written here.
 *
 * Default (agent), owner may override:
 *  - A pack is bought in the person's billing currency: its price and points
 *    in that currency's column of the config. Naira only is paid from the
 *    wallet today (R-16); a person billed in dollars is priced in dollars and
 *    the payment is refused until a dollar wallet can pay it (NUV-09).
 *  - The Founding Maker's bonus (`plan.tier.<id>.pack_bonus_pct`) is added to
 *    the pack's points while the person's tier is running (`active` or
 *    `ending`): the pack's points times the percent, rounded down to a whole
 *    point ("Founding shows +10%").
 */

export const PACK_NOT_FOUND_MESSAGE = 'We could not find that points pack.';
export const PACK_TOO_BIG_MESSAGE =
  'That points pack cannot be sold right now.';

/** A points pack priced for a person. */
export interface PackPlan {
  pack: PlanPack;
  currency: BillingCurrency;
  /** The pack's price in the minor unit of `currency`. */
  priceMinor: number;
  /** The pack's own points. */
  points: number;
  /** The tier's extra points on packs, in percent, while the person's tier runs; 0 otherwise. */
  bonusPercent: number;
  /** `points` times `bonusPercent`, rounded down to a whole point. */
  bonusPoints: number;
  /** `points` plus `bonusPoints`: the one lot the payment grants. */
  totalPoints: number;
  /** How long the lot lasts (the bought-points expiry setting). */
  boughtExpiryDays: number;
}

/** The pack with this id, or null when the config has none. */
export function packById(config: PlansConfig, id: string): PlanPack | null {
  return config.packs.find((p) => p.id === id) ?? null;
}

/**
 * The extra percent the person's tier gives on packs: the tier's own while it
 * runs, else 0 (an ended tier, or none, gives no bonus).
 */
export function packBonusPercentOf(
  held: Pick<HeldTier, 'state' | 'tier'>,
): number {
  return isRunning(held) && held.tier !== null ? held.tier.packBonusPct : 0;
}

/** Prices a pack for a person, or refuses it. */
export function pricePack(
  config: PlansConfig,
  currency: BillingCurrency,
  held: Pick<HeldTier, 'state' | 'tier'>,
  packId: string,
): PackPlan {
  const pack = packById(config, packId);
  if (pack === null)
    throw new PurchaseRefusal('target_not_found', PACK_NOT_FOUND_MESSAGE);
  const points = countIn(pack.points, currency);
  const bonusPercent = packBonusPercentOf(held);
  const bonusPoints = percentOf(points, bonusPercent);
  // The lot's size is an integer column: a pack and a bonus that do not fit
  // it are not sold, rather than failing after the person has paid.
  if (points + bonusPoints > INT4_MAX)
    throw new PurchaseRefusal('target_not_payable', PACK_TOO_BIG_MESSAGE);
  return {
    pack,
    currency,
    priceMinor: priceIn(pack.price, currency),
    points,
    bonusPercent,
    bonusPoints,
    totalPoints: points + bonusPoints,
    boughtExpiryDays: config.points.boughtExpiryDays,
  };
}

/** The line the payment (and so the history row) is titled with: no figure in it. */
export function packTitle(plan: Pick<PackPlan, 'pack'>): string {
  return `Points pack ${plan.pack.id.toUpperCase()}`;
}
