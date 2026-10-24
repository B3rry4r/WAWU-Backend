import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Capital's settings (task NUV-12, R-84, R-10). Read once at boot; a value
 * that is set and wrong stops the server there, naming the setting.
 *
 * On or off is an admin plan setting (`capital.enabled`, default on), not
 * here. These are the limits and WAWU's own fee, from the environment:
 *
 * - `CAPITAL_MIN_KOBO`, `CAPITAL_MAX_KOBO`: the smallest and largest amount
 *   WAWU lets one order carry, on top of the product's own terms. Unset: no
 *   limit of ours (the product's own minimum and maximum still apply).
 * - `CAPITAL_DAILY_MAX_KOBO`: the most one person may confirm in a Lagos
 *   day. Unset: no limit of ours.
 * - `CAPITAL_WAWU_FEE_KOBO` and `CAPITAL_WAWU_FEE_BPS`: WAWU's fee on an
 *   order, a flat amount plus a share in basis points of the amount invested
 *   (R-10: the person pays the provider's fee plus WAWU's on top). Both
 *   default to 0: no fee until the owner sets one.
 *
 * Nuvion's own terms (rate, penalty, withholding tax) are never settings
 * here: they are read from Nuvion for each product.
 */
export interface CapitalLimits {
  minKobo: number | null;
  maxKobo: number | null;
  dailyMaxKobo: number | null;
}

export interface CapitalFeeRule {
  flatKobo: number;
  basisPoints: number;
}

export class CapitalConfigError extends Error {
  constructor(key: string, why: string) {
    super(`${key} ${why}`);
    this.name = 'CapitalConfigError';
  }
}

const MAX_KOBO = 1_000_000_000_000;

function optionalKobo(
  read: (key: string) => string | undefined,
  key: string,
): number | null {
  const raw = read(key);
  if (raw === undefined || raw.trim() === '') return null;
  return wholeKobo(key, raw);
}

function wholeKobo(key: string, raw: string): number {
  const text = raw.trim();
  if (!/^\d{1,13}$/.test(text)) {
    throw new CapitalConfigError(
      key,
      'must be a whole number of kobo (digits only)',
    );
  }
  const n = Number(text);
  if (n > MAX_KOBO) throw new CapitalConfigError(key, 'is too large');
  return n;
}

export function readCapitalLimits(
  read: (key: string) => string | undefined,
): CapitalLimits {
  const minKobo = optionalKobo(read, 'CAPITAL_MIN_KOBO');
  const maxKobo = optionalKobo(read, 'CAPITAL_MAX_KOBO');
  const dailyMaxKobo = optionalKobo(read, 'CAPITAL_DAILY_MAX_KOBO');
  if (minKobo !== null && minKobo < 1) {
    throw new CapitalConfigError('CAPITAL_MIN_KOBO', 'must be 1 or more');
  }
  if (maxKobo !== null && minKobo !== null && maxKobo < minKobo) {
    throw new CapitalConfigError(
      'CAPITAL_MAX_KOBO',
      'must not be below CAPITAL_MIN_KOBO',
    );
  }
  return { minKobo, maxKobo, dailyMaxKobo };
}

export function readCapitalFee(
  read: (key: string) => string | undefined,
): CapitalFeeRule {
  const flatKobo = optionalKobo(read, 'CAPITAL_WAWU_FEE_KOBO') ?? 0;
  const bpsRaw = read('CAPITAL_WAWU_FEE_BPS');
  let basisPoints = 0;
  if (bpsRaw !== undefined && bpsRaw.trim() !== '') {
    if (!/^\d{1,4}$/.test(bpsRaw.trim())) {
      throw new CapitalConfigError(
        'CAPITAL_WAWU_FEE_BPS',
        'must be a whole number of basis points',
      );
    }
    basisPoints = Number(bpsRaw.trim());
    if (basisPoints > 10_000) {
      throw new CapitalConfigError('CAPITAL_WAWU_FEE_BPS', 'is over 100%');
    }
  }
  return { flatKobo, basisPoints };
}

/** WAWU's fee on an amount, in whole kobo, rounded down. Zero by default. */
export function capitalFeeKobo(
  rule: CapitalFeeRule,
  amountKobo: number,
): number {
  const share = Math.floor((amountKobo * rule.basisPoints) / 10_000);
  return rule.flatKobo + share;
}

@Injectable()
export class CapitalSettings {
  readonly limits: CapitalLimits;
  readonly fee: CapitalFeeRule;
  /** A reservation is not confirmed in its last seconds: the provider's clock may differ. */
  readonly expirySafetySeconds = 5;

  constructor(config: ConfigService) {
    const read = (key: string) => config.get<string>(key);
    this.limits = readCapitalLimits(read);
    this.fee = readCapitalFee(read);
  }
}
