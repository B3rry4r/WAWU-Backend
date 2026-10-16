import type { ProviderAccountLimits } from '../wallet-provider/wallet-provider.interface';
import { FintavaConfigError } from './fintava-config';

/**
 * What a Fintava wallet may send in a day (task WALLET-23).
 *
 * Fintava's API publishes no limit. It reports the wallet's tier on the
 * balance read (`data.tier`, `TIER_2` for a new wallet; mobile repo
 * `docs/fintava/sandbox/08-wallet-balance.md`), and the tier's daily limit
 * is Fintava's wallet policy, shared by the owner on 2 Oct 2026
 * (`docs/fintava/limits.md`): Tier 1 N50,000, Tier 2 N500,000, Tier 3
 * N5,000,000 a day. So the tier is read from Fintava on every balance read,
 * and the figure that goes with it is this table, in kobo. The table is a
 * setting: when Fintava changes its policy, `FINTAVA_TIER_DAILY_LIMITS_KOBO`
 * is changed and the server restarted, with no code change.
 *
 * A tier that is not in the table (or no tier at all) has no limit known, so
 * WAWU adds none of its own for it and Fintava's own refusal is the answer.
 */

export const FINTAVA_TIER_LIMITS_KEY = 'FINTAVA_TIER_DAILY_LIMITS_KOBO';

/** The policy of 2 Oct 2026, in kobo (docs/fintava/limits.md). */
export const FINTAVA_POLICY_TIER_DAILY_LIMITS_KOBO: Readonly<
  Record<string, bigint>
> = {
  TIER_1: 5_000_000n,
  TIER_2: 50_000_000n,
  TIER_3: 500_000_000n,
};

/** A tier's daily limit, by the tier's name. A Map: no tier is ever `constructor`. */
export type TierDailyLimits = ReadonlyMap<string, bigint>;

/** The policy table, as a Map. */
export function policyTierLimits(): TierDailyLimits {
  return new Map(Object.entries(FINTAVA_POLICY_TIER_DAILY_LIMITS_KOBO));
}

/**
 * Reads `FINTAVA_TIER_DAILY_LIMITS_KOBO`: `TIER_1:5000000,TIER_2:50000000`,
 * each a tier name, a colon and a whole number of kobo, 1 or more. Unset or
 * blank is the policy table. A value that is set replaces the whole table, so
 * a tier left out has no limit. A set value that cannot be read stops the app
 * at boot, naming the setting.
 */
export function readTierLimits(
  raw: string | undefined | null,
): TierDailyLimits {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return policyTierLimits();
  }
  const table = new Map<string, bigint>();
  for (const part of raw.split(',')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(\d+)\s*$/.exec(part);
    const kobo = m ? BigInt(m[2]) : 0n;
    if (!m || kobo < 1n || kobo > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FintavaConfigError(
        `${FINTAVA_TIER_LIMITS_KEY} must be tier:kobo pairs separated by commas, such as TIER_1:5000000, each a whole number of kobo, 1 or more.`,
      );
    }
    const tier = m[1].toUpperCase();
    if (table.has(tier)) {
      throw new FintavaConfigError(
        `${FINTAVA_TIER_LIMITS_KEY} names ${tier} twice.`,
      );
    }
    table.set(tier, kobo);
  }
  return table;
}

/** The limit that goes with the tier Fintava reported (null: none known). */
export function accountLimitsOf(
  tier: string | null,
  table: TierDailyLimits,
): ProviderAccountLimits {
  const name = tier === null ? null : tier.trim().toUpperCase();
  return {
    tier,
    dailyKobo: name === null ? null : (table.get(name) ?? null),
  };
}
