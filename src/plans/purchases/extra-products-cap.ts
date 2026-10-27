import type { PlansConfig } from '../plans-config';

/**
 * Who may buy the "Add more products" pack, and how many (PACK-CAP, R-100).
 * Pure: the live plan, the tier a person runs and the extras that tier row
 * holds in, a verdict out. Both limits are admin plan settings (R-65), read
 * from the live plan on each call; no figure and no tier id is written here.
 *
 * - `plan.extra_products.tiers`: the tier ids that may buy the pack (the
 *   default is Founding Maker alone). A person on any other tier is led to the
 *   higher tiers instead.
 * - `plan.extra_products.max_packs`: the most packs one profile holds (the
 *   default is 2). Counted on the extras the tier row holds, which a renewal,
 *   a new tier after an ended one and an upgrade leave alone, so the most
 *   products a profile can hold stays the tier's own plus `max_packs` packs
 *   however the tier is renewed. Packs bought before the rule stay as they
 *   were: a person who already holds more than the limit is sold no more.
 *
 * A setting the plan does not carry sells nothing (the live plan always
 * carries both, from the seed).
 */

/** The money error code every refusal of the pack answers with. */
export const PACK_NOT_ALLOWED_CODE = 'pack_not_allowed' as const;

/** The flag a store purchase of the pack carries when it arrives against the rule. */
export const PACK_NOT_ALLOWED_FLAG = PACK_NOT_ALLOWED_CODE;

export const PACK_TIER_MESSAGE =
  'More products come with a higher tier. Move up a tier to add more.';
export const PACK_AT_MOST_MESSAGE =
  "That's the most products a profile can hold.";

/** What the live plan says about the pack. */
export interface PackRule {
  /** Tier ids that may buy the pack. */
  tiers: readonly string[];
  /** The most packs one profile holds. */
  maxPacks: number;
  /** Products in one pack. */
  count: number;
}

export function packRuleOf(
  config: Pick<PlansConfig, 'extraProducts'>,
): PackRule {
  const x = config.extraProducts;
  return { tiers: x.tiers ?? [], maxPacks: x.maxPacks ?? 0, count: x.count };
}

/**
 * Why the pack cannot be sold to a person on `tierId` who holds `extraProducts`
 * extras now, or null when it can. `tier`: their tier may not buy it. `max`:
 * one more pack would take them past the most a profile can hold.
 */
export function packRefusalFor(
  rule: PackRule,
  tierId: string | null,
  extraProducts: number,
): 'tier' | 'max' | null {
  if (tierId === null || !rule.tiers.includes(tierId)) return 'tier';
  if (extraProducts + rule.count > rule.maxPacks * rule.count) return 'max';
  return null;
}

/** The sentence for a refusal. */
export function packRefusalMessage(why: 'tier' | 'max'): string {
  return why === 'tier' ? PACK_TIER_MESSAGE : PACK_AT_MOST_MESSAGE;
}
