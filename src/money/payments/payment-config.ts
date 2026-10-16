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
  reviewAfterHours: 'PAYMENT_REVIEW_AFTER_HOURS',
  chargeReviewAboveKobo: 'PAYMENT_CHARGE_REVIEW_ABOVE_KOBO',
} as const;

/**
 * PROVISIONAL(PAYMENT-REVIEW-AFTER-HOURS, owner=YOU, why=no ruling names how long a payment whose outcome Fintava has not settled is asked about before a person looks at it)
 *
 * A payment whose outcome is unknown stays `pending` and Fintava is asked
 * about it again and again (backing off to hourly); absence is never taken
 * as proof that no money left the buyer's wallet (lead ruling D1, 4 Oct
 * 2026). Past this many hours with no answer it goes to manual review: still
 * `pending`, still blocking a second payment for the same item, no longer
 * in the sweep; Fintava's webhook or the ledger's status check still
 * settles it. Three days is the ledger's own confirm window
 * (LEDGER_CONFIRM_WINDOW_HOURS). Overridable (1 to 720).
 */
export const DEFAULT_PAYMENT_REVIEW_AFTER_HOURS = 72;

/**
 * PROVISIONAL(IDEMPOTENCY-KEY-HOURS, owner=YOU, why=CONVENTIONS section 4 says keys are kept at least 24 hours and leaves the length to MONEY-17; no ruling names it)
 *
 * How long the stored answer to a money-moving request is kept, so a retry
 * of the same intent with the same Idempotency-Key is answered from it and
 * never pays twice. Two days covers an app that retries the next morning.
 * Overridable with IDEMPOTENCY_KEY_HOURS (24 to 720).
 */
export const DEFAULT_IDEMPOTENCY_KEY_HOURS = 48;

/**
 * PROVISIONAL(PAYMENT-CHARGE-REVIEW-ABOVE-KOBO, owner=YOU, why=no ruling names how far the provider's charge on a purchase may be above the quoted one before it is not believed; the lead's default for MONEY-17 round 8 finding N2 is 1000 naira)
 *
 * How far above the QUOTED provider charge a payment's real charge may be and
 * still be believed, in kobo (MONEY-18, MONEY-17's N2). A charge above the
 * quote by more than this, or below 0, is not trusted: the payment is not
 * completed or delivered at it. It goes to review with both figures
 * (`chargeReviewSince`, `discrepancy`) and stays there until a person looks.
 * A charge above the quote by this much or less is believed: the payment
 * completes at it and is flagged (`debitReviewSince`) as before. Overridable
 * with PAYMENT_CHARGE_REVIEW_ABOVE_KOBO (0 to 100000000); 0 means any charge
 * above the quote is reviewed.
 */
export const DEFAULT_PAYMENT_CHARGE_REVIEW_ABOVE_KOBO = 100_000;

/** Read once at boot. A set but unusable value stops the app. */
@Injectable()
export class PaymentSettings {
  readonly idempotencyKeyHours: number;
  readonly reviewAfterHours: number;
  readonly chargeReviewAboveKobo: number;

  constructor(config: ConfigService) {
    const review = PAYMENT_CONFIG_KEYS.reviewAfterHours;
    try {
      this.reviewAfterHours = koboSetting(
        config.get<string>(review),
        review,
        DEFAULT_PAYMENT_REVIEW_AFTER_HOURS,
        1,
        720,
      );
    } catch (e) {
      if (e instanceof FeeConfigError) {
        throw new FeeConfigError(
          `${review} must be a whole number of hours from 1 to 720.`,
        );
      }
      throw e;
    }
    const above = PAYMENT_CONFIG_KEYS.chargeReviewAboveKobo;
    try {
      this.chargeReviewAboveKobo = koboSetting(
        config.get<string>(above),
        above,
        DEFAULT_PAYMENT_CHARGE_REVIEW_ABOVE_KOBO,
        0,
        100_000_000,
      );
    } catch (e) {
      if (e instanceof FeeConfigError) {
        throw new FeeConfigError(
          `${above} must be a whole number of kobo from 0 to 100000000.`,
        );
      }
      throw e;
    }
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
