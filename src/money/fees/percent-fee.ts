import { FeeConfigError, koboSetting } from './fee-config';

/**
 * A percentage fee with an optional floor and cap (task NUV-FEES; R-10, R-138).
 * Nuvion's live charges on a payout to a Nigerian bank and on a transfer in
 * are a share of the amount with a minimum and, for the payout, a maximum.
 *
 * Written `pct:0.2,min:5000,max:50000` (percent, then the floor and the cap
 * in kobo, each optional, in any order). The percent has up to four decimal
 * places and is held as a whole number of millionths, so no fee is ever
 * worked out in floating point.
 *
 * This file holds the arithmetic only (the scale of a percentage, the half
 * that rounds up). It holds no fee figure: every figure arrives in a setting.
 * It sits outside the files the no-fee-figure spec scans for that reason.
 *
 * PROVISIONAL(NUV-FEES-ROUNDING, owner=YOU, why=no recorded Nuvion answer shows how it rounds a fraction of a kobo on a percentage fee; the nearest kobo, halves up, is used until a live applicable_fee on an odd amount shows otherwise)
 */

const MILLIONTHS = 1_000_000n;
const HALF = 500_000n;
const DECIMALS = 4;
const POW = 10_000;
/** Most a percentage may be: all of the amount. */
const MAX_PPM = 1_000_000;

export interface PercentFee {
  /** The percentage in millionths of the amount (0.2% is 2000). */
  readonly ppm: number;
  /** The fee is never below this, in kobo. */
  readonly minKobo: number;
  /** The fee is never above this, in kobo; null for no cap. */
  readonly maxKobo: number | null;
}

/** True for a setting written as a percentage. */
export function isPercentSetting(text: string): boolean {
  return /^pct\s*:/i.test(text.trim());
}

/** Reads `pct:0.2,min:5000,max:50000`; anything else unusable stops the app. */
export function parsePercentFee(text: string, key: string): PercentFee {
  const shape = `${key} as a percentage must look like pct:0.2,min:5000,max:50000 (percent, then an optional minimum and maximum in kobo).`;
  const seen = new Set<string>();
  let ppm: number | null = null;
  let minKobo = 0;
  let maxKobo: number | null = null;
  for (const part of text.split(',')) {
    const pieces = part.trim().split(':');
    if (pieces.length !== 2) throw new FeeConfigError(shape);
    const name = pieces[0].trim().toLowerCase();
    const value = pieces[1].trim();
    if (seen.has(name)) throw new FeeConfigError(shape);
    seen.add(name);
    if (name === 'pct') {
      const m = new RegExp(`^(\\d{1,3})(?:\\.(\\d{1,${DECIMALS}}))?$`).exec(
        value,
      );
      if (!m) throw new FeeConfigError(shape);
      ppm =
        Number(m[1]) * POW + Number((m[2] ?? '').padEnd(DECIMALS, '0') || '0');
      if (ppm <= 0 || ppm > MAX_PPM) throw new FeeConfigError(shape);
    } else if (name === 'min') {
      minKobo = koboSetting(value, key, Number.NaN);
    } else if (name === 'max') {
      maxKobo = koboSetting(value, key, Number.NaN);
    } else {
      throw new FeeConfigError(shape);
    }
  }
  if (ppm === null || (maxKobo !== null && minKobo > maxKobo)) {
    throw new FeeConfigError(shape);
  }
  return { ppm, minKobo, maxKobo };
}

/** The fee on this amount: the share, to the nearest kobo (halves up), then the floor, then the cap. */
export function percentFeeOf(rule: PercentFee, amountKobo: number): number {
  const share = Number(
    (BigInt(amountKobo) * BigInt(rule.ppm) + HALF) / MILLIONTHS,
  );
  const floored = Math.max(share, rule.minKobo);
  return rule.maxKobo === null ? floored : Math.min(floored, rule.maxKobo);
}
