/**
 * The fee rule (FEE-01, R-139 point 1), in whole minor units with no floating
 * point: fee = the percentage of the amount, to the nearest minor unit (a
 * half rounds up), raised to the minimum, lowered to the maximum. Arithmetic
 * only: this file holds no fee figure. The percentage is held as whole
 * millionths (0.4% is 4000), which is how the schedule stores it.
 *
 * Reused from the stopped NUV-FEES branch (percent-fee.ts, 4c28ef51), moved
 * to BigInt end to end and to millionths for a percentage.
 */

const MILLIONTHS = 1_000_000n;
const HALF = 500_000n;
const DECIMALS = 4;
const POW = 10_000;
/** Most a percentage may be: all of the amount. */
export const MAX_PPM = 1_000_000;

export interface FeeRule {
  /** The percentage in millionths of the amount. */
  readonly ppm: number;
  /** The fee is never below this, in minor units. */
  readonly minMinor: bigint;
  /** The fee is never above this; null for no cap. */
  readonly maxMinor: bigint | null;
}

/** "0.4" to 4000. Up to four decimals; anything else is null. */
export function percentToPpm(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!m) return null;
  const ppm = Number(m[1]) * POW + Number((m[2] ?? '').padEnd(DECIMALS, '0'));
  return ppm > MAX_PPM ? null : ppm;
}

/** 4000 to "0.4", 12500 to "1.25", 0 to "0". No trailing zeros. */
export function ppmToPercent(ppm: number): string {
  const whole = Math.floor(ppm / POW);
  const frac = String(ppm % POW)
    .padStart(DECIMALS, '0')
    .replace(/0+$/, '');
  return frac === '' ? String(whole) : `${whole}.${frac}`;
}

/** The share of an amount, to the nearest minor unit (halves up). */
export function shareOf(ppm: number, amountMinor: bigint): bigint {
  return (amountMinor * BigInt(ppm) + HALF) / MILLIONTHS;
}

/** The fee on this amount under the rule. */
export function feeOf(rule: FeeRule, amountMinor: bigint): bigint {
  const share = shareOf(rule.ppm, amountMinor);
  const floored = share < rule.minMinor ? rule.minMinor : share;
  return rule.maxMinor !== null && floored > rule.maxMinor
    ? rule.maxMinor
    : floored;
}
