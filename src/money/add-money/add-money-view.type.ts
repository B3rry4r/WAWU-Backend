import type { AddMoneyRail } from '../../wallet-provider/add-money';

/**
 * What the add-money routes answer (WALLET-25, WALLET-26; R-84). Money is
 * integer kobo; nothing here is a balance (the wallet's is the provider's,
 * MONEY-11). Words a person reads are ours, never a provider's text.
 */

/** Where an attempt stands, for the person: see `AddMoneySession` in the schema. */
export type AddMoneyStatus =
  | 'created'
  | 'awaiting_user'
  | 'processing'
  | 'settled'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** One way to add money, and whether it can be used now. */
export interface AddMoneyRailView {
  rail: AddMoneyRail;
  available: boolean;
  /** Why it cannot be used, in plain words; null when it can. */
  reason: string | null;
  /** True when the person finishes on a page the provider hosts (opened in the browser). */
  hosted: boolean;
}

/** `GET /money/add-money/options`. */
export interface AddMoneyOptionsView {
  currency: 'NGN';
  rails: AddMoneyRailView[];
  /**
   * The provider's public key (PEM) the phone encrypts a card with, so the
   * card never reaches WAWU's servers in the clear. Null when card payments
   * are not offered.
   */
  cardPublicKey: string | null;
  /** WAWU's limits in kobo; null for none. */
  limits: {
    minKobo: number | null;
    maxKobo: number | null;
    dailyMaxKobo: number | null;
  };
}

/** `GET /money/add-money/quote`. The person pays `chargeKobo` and the wallet gets `amountKobo`. */
export interface AddMoneyQuoteView {
  rail: AddMoneyRail;
  currency: 'NGN';
  amountKobo: number;
  /** The provider's charge (config). */
  providerFeeKobo: number;
  /** WAWU's fee on top (config, default 0). */
  wawuFeeKobo: number;
  feeKobo: number;
  chargeKobo: number;
}

/** One attempt (`POST /money/add-money`, `GET /money/add-money/{id}`). */
export interface AddMoneyView {
  id: string;
  rail: AddMoneyRail;
  status: AddMoneyStatus;
  currency: 'NGN';
  amountKobo: number;
  chargeKobo: number;
  providerFeeKobo: number;
  wawuFeeKobo: number;
  /** A hosted page to open in the browser (3-D Secure, Apple Pay, the bank checkout); null when there is none now. */
  checkoutUrl: string | null;
  /** One plain line for where it stands. */
  message: string;
  /** Why it failed, in plain words; null unless `failed` or `expired`. */
  failureMessage: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  expiresAt: string | null;
  createdAt: string;
  creditedAt: string | null;
}

export interface AddMoneyPage {
  items: AddMoneyView[];
  nextCursor: string | null;
}

/** One attempt as an admin sees it. */
export interface AdminAddMoneyView extends AddMoneyView {
  wawuUserId: string;
  provider: string;
  reference: string;
  providerRef: string | null;
  frozen: boolean;
  failureCode: string | null;
  reviewNote: string | null;
  feeCollectedAt: string | null;
  audits: {
    action: string;
    reason: string | null;
    fromStatus: string;
    toStatus: string;
    actedByAdminEmail: string;
    actedAt: string;
  }[];
}

export interface AdminAddMoneyPage {
  items: AdminAddMoneyView[];
  nextCursor: string | null;
}
