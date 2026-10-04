import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BILL_CATEGORIES, type BillCategory } from '../dto/money-enums';

/**
 * The fee schedule the quote is built from (task WALLET-15, R-10, R-31).
 *
 * The user pays Fintava's charge for the action plus WAWU's fee on top
 * (R-10). Fintava's charges are its dashboard rates, final, in the mobile
 * repo's `docs/fintava/fees.md` (owner, 2 Oct 2026: "These dashboard rates
 * are the ones we use"; the sandbox's ₦0 on wallet to wallet does not change
 * them). WAWU's fees are R-10's. Neither is a PROVISIONAL default: both are
 * ruled. Each can still be set in the environment, so the day Fintava or the
 * owner changes one, the quote follows without a release (the dashboard's
 * merchant charges, OPS-09, must be changed to the same figure: the nightly
 * check, MONEY-16, reports a difference).
 *
 * Every figure is kobo, an integer. A fee is never a float.
 */
export const FEE_CONFIG_KEYS = {
  balanceTransferBands: 'FINTAVA_FEE_BALANCE_TRANSFER_BANDS',
  bankTransfer: 'FINTAVA_FEE_BANK_TRANSFER_KOBO',
  electricity: 'FINTAVA_FEE_ELECTRICITY_KOBO',
  cable: 'FINTAVA_FEE_CABLE_KOBO',
  airtime: 'FINTAVA_FEE_AIRTIME_KOBO',
  data: 'FINTAVA_FEE_DATA_KOBO',
  wawuTransferWawuFee: 'WAWU_FEE_WAWU_TRANSFER_KOBO',
  bankTransferWawuFee: 'WAWU_FEE_BANK_TRANSFER_KOBO',
  billWawuFee: 'WAWU_FEE_BILL_KOBO',
  merchantMaxPerTxn: 'MERCHANT_MAX_PER_TXN_KOBO',
  quoteSeconds: 'FEE_QUOTE_SECONDS',
  quoteKey: 'FEE_QUOTE_KEY',
} as const;

/**
 * One band of Fintava's balance-transfer (wallet to wallet) charge: an
 * amount from `fromKobo` up to the next band's `fromKobo` costs `feeKobo`.
 */
export interface FeeBand {
  fromKobo: number;
  feeKobo: number;
}

/**
 * Fintava's balance-transfer charge by amount (`fees.md`): below ₦5,000
 * ₦23.25; below ₦50,000 ₦15.75; above ₦50,000 ₦15.75. "Below ₦5,000" makes
 * ₦5,000 itself the second band (WALLET-15's check: ₦4,999 pays ₦23.25,
 * ₦5,000 pays ₦15.75). The third band is kept although its charge equals
 * the second's, so the schedule reads like the dashboard.
 */
export const DEFAULT_BALANCE_TRANSFER_BANDS: readonly FeeBand[] = [
  { fromKobo: 0, feeKobo: 2325 },
  { fromKobo: 500_000, feeKobo: 1575 },
  { fromKobo: 5_000_000, feeKobo: 1575 },
];

/** Fintava's "transfer fee" on a send to a bank (`fees.md`): ₦40. */
export const DEFAULT_BANK_TRANSFER_FEE_KOBO = 4000;

/** Fintava's bill charges by category (`fees.md`): electricity and cable ₦100, airtime and data ₦0. */
export const DEFAULT_BILL_FEE_KOBO: Readonly<Record<BillCategory, number>> = {
  electricity: 10_000,
  cable: 10_000,
  airtime: 0,
  data: 0,
};

/** WAWU's fee on a send to another WAWU user (R-10): ₦10. */
export const DEFAULT_WAWU_TRANSFER_WAWU_FEE_KOBO = 1000;

/** WAWU's fee on a send or withdrawal to a bank (R-10): ₦25. */
export const DEFAULT_BANK_TRANSFER_WAWU_FEE_KOBO = 2500;

/** WAWU's fee on a bill (`fees.md`: "plus WAWU's bill fee if one is set"; none is): ₦0. */
export const DEFAULT_BILL_WAWU_FEE_KOBO = 0;

/**
 * Fintava's per-transaction cap on WAWU's merchant wallet, ₦10,000,000
 * (mobile repo `docs/fintava/limits.md`; `.env.example` sets the same).
 * Used only when MERCHANT_MAX_PER_TXN_KOBO is left empty.
 */
export const DEFAULT_MERCHANT_MAX_PER_TXN_KOBO = 1_000_000_000;

/** The largest single fee a setting may hold: ₦10,000. Anything above is a typo. */
export const MAX_FEE_KOBO = 1_000_000;

/**
 * PROVISIONAL(FEE-QUOTE-SECONDS, owner=YOU, why=no ruling names how long a quoted fee may be paid at; a review screen left open longer is re-quoted)
 *
 * How long a quote can be paid at. After it, the send or payment that
 * carries it answers `409 quote_changed` with a fresh quote, so a fee the
 * person saw an hour ago is never charged without being shown again. Five
 * minutes covers reading the review screen and entering the PIN.
 * Overridable with FEE_QUOTE_SECONDS (60 to 3600).
 */
export const DEFAULT_FEE_QUOTE_SECONDS = 300;

/** The shortest FEE_QUOTE_KEY accepted: 32 characters (`openssl rand -hex 32` gives 64). */
export const FEE_QUOTE_KEY_MIN_LENGTH = 32;

/** A set but unusable fee setting. Stops the app at boot. */
export class FeeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeConfigError';
  }
}

function blank(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '';
}

/** A whole number of kobo from `min` to `max`; empty means the default. */
export function koboSetting(
  raw: string | undefined,
  key: string,
  fallback: number,
  min = 0,
  max = MAX_FEE_KOBO,
): number {
  if (blank(raw)) return fallback;
  const text = raw!.trim();
  const n = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new FeeConfigError(
      `${key} must be a whole number of kobo from ${min} to ${max}.`,
    );
  }
  return n;
}

/**
 * Reads FINTAVA_FEE_BALANCE_TRANSFER_BANDS: `from:fee` pairs in kobo,
 * comma separated, the first from 0, each `from` above the one before
 * (the default is `0:2325,500000:1575,5000000:1575`).
 */
export function bandsSetting(raw: string | undefined): readonly FeeBand[] {
  const key = FEE_CONFIG_KEYS.balanceTransferBands;
  if (blank(raw)) return DEFAULT_BALANCE_TRANSFER_BANDS;
  const bands: FeeBand[] = [];
  for (const pair of raw!.split(',')) {
    const parts = pair.trim().split(':');
    if (parts.length !== 2) {
      throw new FeeConfigError(
        `${key} must be from:fee pairs in kobo, comma separated, such as 0:2325,500000:1575.`,
      );
    }
    const fromKobo = koboSetting(
      parts[0],
      key,
      NaN,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const feeKobo = koboSetting(parts[1], key, NaN);
    if (Number.isNaN(fromKobo) || Number.isNaN(feeKobo)) {
      throw new FeeConfigError(`${key} has an empty band.`);
    }
    const prev = bands[bands.length - 1];
    if (prev ? fromKobo <= prev.fromKobo : fromKobo !== 0) {
      throw new FeeConfigError(
        `${key}: the first band starts at 0 and each next one higher.`,
      );
    }
    bands.push({ fromKobo, feeKobo });
  }
  return bands;
}

/** Reads FEE_QUOTE_SECONDS (60 to 3600); empty means the provisional default. */
export function quoteSecondsSetting(raw: string | undefined): number {
  return koboSetting(
    raw,
    FEE_CONFIG_KEYS.quoteSeconds,
    DEFAULT_FEE_QUOTE_SECONDS,
    60,
    3600,
  );
}

/**
 * The fee schedule, read once at boot. A setting left empty takes the
 * ruled figure above; a setting that is set but unusable stops the app.
 *
 * FEE_QUOTE_KEY signs each quote (fee-quote.service.ts), so the send or
 * payment that later carries it can tell a quote this server gave from one
 * it did not, and when it was given. Left empty, the server makes a random
 * key at boot: quotes then stop being honoured when the server restarts,
 * which costs a person one re-quote (`quote_changed` with the new one),
 * never a wrong charge. Set it when more than one server answers. The key
 * is in a private field: not in `inspect`, not in JSON, never logged.
 */
@Injectable()
export class FeeSettings {
  private readonly logger = new Logger(FeeSettings.name);
  readonly balanceTransferBands: readonly FeeBand[];
  readonly bankTransferFeeKobo: number;
  readonly billFeeKobo: Readonly<Record<BillCategory, number>>;
  readonly wawuTransferWawuFeeKobo: number;
  readonly bankTransferWawuFeeKobo: number;
  readonly billWawuFeeKobo: number;
  /** Only on money through WAWU's merchant wallet: purchases and bills. */
  readonly merchantMaxPerTxnKobo: number;
  readonly quoteSeconds: number;
  readonly #quoteKey: Buffer;

  constructor(config: ConfigService) {
    const get = (key: string) => config.get<string>(key);
    const K = FEE_CONFIG_KEYS;
    this.balanceTransferBands = bandsSetting(get(K.balanceTransferBands));
    this.bankTransferFeeKobo = koboSetting(
      get(K.bankTransfer),
      K.bankTransfer,
      DEFAULT_BANK_TRANSFER_FEE_KOBO,
    );
    const bill = {} as Record<BillCategory, number>;
    for (const category of BILL_CATEGORIES) {
      bill[category] = koboSetting(
        get(K[category]),
        K[category],
        DEFAULT_BILL_FEE_KOBO[category],
      );
    }
    this.billFeeKobo = bill;
    this.wawuTransferWawuFeeKobo = koboSetting(
      get(K.wawuTransferWawuFee),
      K.wawuTransferWawuFee,
      DEFAULT_WAWU_TRANSFER_WAWU_FEE_KOBO,
    );
    this.bankTransferWawuFeeKobo = koboSetting(
      get(K.bankTransferWawuFee),
      K.bankTransferWawuFee,
      DEFAULT_BANK_TRANSFER_WAWU_FEE_KOBO,
    );
    this.billWawuFeeKobo = koboSetting(
      get(K.billWawuFee),
      K.billWawuFee,
      DEFAULT_BILL_WAWU_FEE_KOBO,
    );
    this.merchantMaxPerTxnKobo = koboSetting(
      get(K.merchantMaxPerTxn),
      K.merchantMaxPerTxn,
      DEFAULT_MERCHANT_MAX_PER_TXN_KOBO,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    this.quoteSeconds = quoteSecondsSetting(get(K.quoteSeconds));

    const key = (get(K.quoteKey) ?? '').trim();
    if (key === '') {
      this.#quoteKey = randomBytes(32);
      this.logger.warn(
        `${K.quoteKey} is not set: fee quotes are signed with a key made at boot and stop being honoured when the server restarts.`,
      );
    } else if (key.length < FEE_QUOTE_KEY_MIN_LENGTH) {
      throw new FeeConfigError(
        `${K.quoteKey} must be at least ${FEE_QUOTE_KEY_MIN_LENGTH} characters.`,
      );
    } else {
      this.#quoteKey = Buffer.from(key, 'utf8');
    }
  }

  /** The key quotes are signed under. Only fee-quote.service.ts reads it. */
  quoteKey(): Buffer {
    return this.#quoteKey;
  }

  /** Fintava's balance-transfer charge on moving this amount between wallets. */
  balanceTransferFeeKobo(amountKobo: number): number {
    let fee = this.balanceTransferBands[0].feeKobo;
    for (const band of this.balanceTransferBands) {
      if (amountKobo >= band.fromKobo) fee = band.feeKobo;
    }
    return fee;
  }
}
