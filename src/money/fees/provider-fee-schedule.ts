import type { WalletProviderName } from '../../wallet-provider/wallet-provider.interface';
import type { BillCategory } from '../dto/money-enums';
import type { FeeSettings } from './fee-config';
import {
  feeOf,
  type FeeRule,
  NUVION_FEE_CONFIG_KEYS,
  readNuvionFees,
} from './nuvion-fee-config';

/**
 * The provider's part of a fee quote, per provider (task NUV-07). The quote
 * (fee-quote.service.ts) asks the running provider's schedule for the
 * provider's charge and adds WAWU's own fee on top (R-10), whichever provider
 * runs; R-23's one Fees row is the two together.
 *
 * - `fintava`: exactly the WALLET-15 schedule in FeeSettings (fee-config.ts),
 *   ruled figures, unchanged, so a rollback quotes what it always quoted.
 * - `nuvion`: Nuvion's charges from the NUVION_FEE_* settings
 *   (nuvion-fee-config.ts), no default; `unset` lists the ones still missing
 *   and the quote answers `fees_not_set` while it is not empty. Nuvion has no
 *   bill payments (R-39) and its operational account has no documented cap.
 *
 * Every figure is integer kobo.
 */
export interface ProviderFeeSchedule {
  readonly provider: WalletProviderName;
  /** The settings this schedule still needs; empty when every charge is set. */
  readonly unset: readonly string[];
  /** Whether bills can be paid through this provider at all. */
  readonly bills: boolean;
  /**
   * The cap on one movement through WAWU's own account (purchases and bills,
   * MERCHANT_MAX_PER_TXN_KOBO under Fintava); null when there is none.
   */
  readonly merchantMaxPerTxnKobo: number | null;
  /** The charge on a move between two wallets at the provider (`balance_transfer`). */
  walletToWalletKobo(amountKobo: number): number;
  /** The charge on a send to a bank account (`bank_transfer`). */
  bankTransferKobo(amountKobo: number): number;
  /** A bill's charge by category (`bill_charge`); only asked when `bills`. */
  billChargeKobo(category: BillCategory): number;
  /**
   * The charge on money arriving by bank transfer, for the add-money and
   * pay-by-transfer tasks (NUV-04, TIER-05); null when the provider's
   * schedule names none (Fintava's dashboard list has no inflow charge).
   */
  inflowKobo(amountKobo: number): number | null;
}

/** Fintava's schedule: the WALLET-15 settings, read exactly as before. */
export function fintavaFeeSchedule(s: FeeSettings): ProviderFeeSchedule {
  return {
    provider: 'fintava',
    unset: [],
    bills: true,
    merchantMaxPerTxnKobo: s.merchantMaxPerTxnKobo,
    walletToWalletKobo: (amountKobo) => s.balanceTransferFeeKobo(amountKobo),
    bankTransferKobo: () => s.bankTransferFeeKobo,
    billChargeKobo: (category) => s.billFeeKobo[category],
    inflowKobo: () => null,
  };
}

/** A charge that must be set before it is read: fees_not_set comes first. */
function requireRule(rule: FeeRule | null, key: string): FeeRule {
  if (rule === null) {
    throw new Error(`${key} is not set; fees_not_set must be answered first.`);
  }
  return rule;
}

/** Nuvion's schedule from the NUVION_FEE_* settings read through `get`. */
export function nuvionFeeSchedule(
  get: (key: string) => string | undefined | null,
): ProviderFeeSchedule {
  const fees = readNuvionFees(get);
  const K = NUVION_FEE_CONFIG_KEYS;
  return {
    provider: 'nuvion',
    unset: fees.unset,
    bills: false,
    merchantMaxPerTxnKobo: null,
    walletToWalletKobo: (amountKobo) =>
      feeOf(requireRule(fees.bookTransfer, K.bookTransfer), amountKobo),
    bankTransferKobo: (amountKobo) =>
      feeOf(requireRule(fees.bankPayout, K.bankPayout), amountKobo),
    billChargeKobo: () => {
      throw new Error('Nuvion has no bill payments.');
    },
    inflowKobo: (amountKobo) =>
      feeOf(requireRule(fees.inflow, K.inflow), amountKobo),
  };
}

/**
 * The running provider's schedule. Nuvion's settings are read only when
 * Nuvion runs, so a Fintava server never reads (or trips on) them.
 */
export function providerFeeSchedule(
  provider: WalletProviderName,
  settings: FeeSettings,
  get: (key: string) => string | undefined | null,
): ProviderFeeSchedule {
  return provider === 'nuvion'
    ? nuvionFeeSchedule(get)
    : fintavaFeeSchedule(settings);
}

/**
 * The running provider's fee settings that are still unset, without building
 * a quote: what the money-moving check (src/money/limits/) asks before any
 * call. Fintava's schedule always has its ruled figures, so it is never unset.
 */
export function unsetFeeSettings(
  provider: WalletProviderName,
  get: (key: string) => string | undefined | null,
): readonly string[] {
  return provider === 'nuvion' ? readNuvionFees(get).unset : [];
}
