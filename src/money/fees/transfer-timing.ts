import type { TransferInView } from '../money-view.type';
import { FeeConfigError } from './fee-config';
import { readNuvionFees } from './nuvion-fee-config';

/**
 * How long a bank transfer takes, and what money arriving by transfer costs:
 * the two facts Add money (W15, W45), Withdraw (W17) and the transfer's
 * timeline (W19) say in a line, served by the Hub so the app writes no figure
 * of its own (FIX-109; BACKEND_GAPS G-WALLET-05-2, -3, G-FIX-68-1, -2).
 *
 * Neither is a default. WAWU keeps no promise the bank has not made:
 *
 *   MONEY_ARRIVAL_BANK_OUT_MINUTES  how long a send to a bank account usually
 *                                   takes to reach it (W17, W19)
 *   MONEY_ARRIVAL_BANK_IN_MINUTES   how long a transfer into a person's wallet
 *                                   account usually takes to land (W15, W45)
 *
 * Each is whole minutes, 1 to 1440, or unset. Unset means the Hub says
 * nothing and the app draws no line. A value that is set but unusable stops
 * the server at boot, naming the setting. The inflow fee is the running
 * provider's own setting (`NUVION_FEE_INFLOW`, nuvion-fee-config.ts); a
 * provider whose schedule names no inflow charge says nothing either.
 */
export const ARRIVAL_CONFIG_KEYS = {
  bankOut: 'MONEY_ARRIVAL_BANK_OUT_MINUTES',
  bankIn: 'MONEY_ARRIVAL_BANK_IN_MINUTES',
} as const;

export const MAX_ARRIVAL_MINUTES = 1440;

/** Whole minutes from 1 to a day, or null when unset. Anything else stops the app. */
export function arrivalMinutesSetting(
  raw: string | undefined | null,
  key: string,
): number | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const text = raw.trim();
  const n = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ARRIVAL_MINUTES) {
    throw new FeeConfigError(
      `${key} must be a whole number of minutes from 1 to ${MAX_ARRIVAL_MINUTES}.`,
    );
  }
  return n;
}

export interface TransferTiming {
  /** A send to a bank account: minutes it usually takes. Null when unset. */
  readonly bankOutMinutes: number | null;
  /** A transfer into the wallet account: minutes it usually takes. Null when unset. */
  readonly bankInMinutes: number | null;
}

export function readTransferTiming(
  get: (key: string) => string | undefined | null,
): TransferTiming {
  const K = ARRIVAL_CONFIG_KEYS;
  return {
    bankOutMinutes: arrivalMinutesSetting(get(K.bankOut), K.bankOut),
    bankInMinutes: arrivalMinutesSetting(get(K.bankIn), K.bankIn),
  };
}

/**
 * What is known about a transfer in, for this provider. Only Nuvion's
 * schedule names an inflow charge; one flat figure, or bands that all charge
 * the same, is a figure. Null when nothing is known (the view then carries no
 * `transferIn` at all).
 */
export function transferInOf(
  providerName: string,
  timing: TransferTiming,
  get: (key: string) => string | undefined | null,
): TransferInView | null {
  const view: TransferInView = {};
  if (providerName === 'nuvion') {
    const rule = readNuvionFees(get).inflow;
    if (rule?.kind === 'flat') view.feeKobo = rule.feeKobo;
    else if (rule?.kind === 'bands') {
      const first = rule.bands[0].feeKobo;
      if (rule.bands.every((b) => b.feeKobo === first)) view.feeKobo = first;
    }
  }
  if (timing.bankInMinutes !== null) {
    view.arrivalMinutes = timing.bankInMinutes;
  }
  return Object.keys(view).length === 0 ? null : view;
}
