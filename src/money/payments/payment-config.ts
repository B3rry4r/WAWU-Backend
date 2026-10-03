import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeeConfigError, koboSetting } from '../fees/fee-config';

/**
 * Pay from wallet's settings (task MONEY-17).
 *
 * Every split is 85/15 (R-5, owner, 21 Sep 2026: one split on every
 * stream), of the price only, never of the price plus Fintava's charge
 * (R-10). It is a ruling, not a setting: there is no rate to configure.
 */
export const PAYEE_SHARE_BPS = 8500;

/** The split of one price: the payee's 85% rounded down, WAWU's the rest. */
export function splitPrice(
  priceKobo: number,
  hasPayee: boolean,
): { payeeShareKobo: number; wawuShareKobo: number } {
  if (!Number.isSafeInteger(priceKobo) || priceKobo < 1) {
    throw new RangeError('splitPrice: the price is a positive whole kobo.');
  }
  if (!hasPayee) return { payeeShareKobo: 0, wawuShareKobo: priceKobo };
  // Integer arithmetic only: price * 8500 stays exact below 2^53 for any
  // price up to about ₦10.6 billion, far above the merchant cap.
  const payeeShareKobo = Math.floor((priceKobo * PAYEE_SHARE_BPS) / 10_000);
  return { payeeShareKobo, wawuShareKobo: priceKobo - payeeShareKobo };
}

export const PAYMENT_CONFIG_KEYS = {
  idempotencyKeyHours: 'IDEMPOTENCY_KEY_HOURS',
} as const;

/**
 * PROVISIONAL(IDEMPOTENCY-KEY-HOURS, owner=YOU, why=CONVENTIONS section 4 says keys are kept at least 24 hours and leaves the length to MONEY-17; no ruling names it)
 *
 * How long the stored answer to a money-moving request is kept, so a retry
 * of the same intent with the same Idempotency-Key is answered from it and
 * never pays twice. Two days covers an app that retries the next morning.
 * Overridable with IDEMPOTENCY_KEY_HOURS (24 to 720).
 */
export const DEFAULT_IDEMPOTENCY_KEY_HOURS = 48;

/** Read once at boot. A set but unusable value stops the app. */
@Injectable()
export class PaymentSettings {
  readonly idempotencyKeyHours: number;

  constructor(config: ConfigService) {
    const key = PAYMENT_CONFIG_KEYS.idempotencyKeyHours;
    try {
      this.idempotencyKeyHours = koboSetting(
        config.get<string>(key),
        key,
        DEFAULT_IDEMPOTENCY_KEY_HOURS,
        24,
        720,
      );
    } catch (e) {
      if (e instanceof FeeConfigError) {
        throw new FeeConfigError(
          `${key} must be a whole number of hours from 24 to 720.`,
        );
      }
      throw e;
    }
  }
}
