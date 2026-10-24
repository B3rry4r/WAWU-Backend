/**
 * Adding money to a wallet from outside WAWU, through the wallet provider seam
 * (WALLET-25 card and Apple Pay, WALLET-26 USSD and the bank checkout; R-84).
 *
 * Kept in its own file and reached by `addMoneyOf(provider)`, so the seam's
 * main interface (wallet-provider.interface.ts) is untouched: a provider that
 * implements none of these (Fintava's adapter) simply has none, and every
 * caller answers `not_supported` for it. Nothing under `src/money/` imports a
 * provider's client; this is the one place its add-money shapes are written.
 *
 * Amounts are integer kobo as `bigint`, as everywhere in the seam. Nothing
 * here is a provider's wire shape: an adapter reads its answers field by field
 * and maps them to these types.
 */
import type { WalletProvider } from './wallet-provider.interface';

/** The ways money comes in that are not an account number to send to. */
export const ADD_MONEY_RAILS = [
  'card',
  'apple_pay',
  'ussd',
  'open_banking',
] as const;
export type AddMoneyRail = (typeof ADD_MONEY_RAILS)[number];

/**
 * Where an attempt stands at the provider, in neutral words. `paid` means the
 * provider took the payment (a charge that went through, a session that
 * settled): the money reaches the wallet by the inflow the provider records
 * on the account, which can come later (a card settles after the charge).
 */
export type ProviderAddMoneyState =
  | 'created'
  | 'awaiting_user'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** The two ids of the person's wallet an attempt pays into. */
export interface ProviderAddMoneyWallet {
  customerId: string;
  walletId: string;
}

/** The payer, as a card payment names them. */
export interface ProviderAddMoneyPayer {
  firstName: string;
  lastName: string;
  email: string;
  /** E.164, or null. */
  phone: string | null;
}

/** What the cardholder's phone says of itself, for the card network's 3-D Secure check. */
export interface ProviderCardBrowser {
  acceptHeader: string;
  userAgent: string;
  language: string;
  screenWidth: string;
  screenHeight: string;
  colorDepth: string;
  timezoneOffset: string;
  ipAddress: string;
}

export interface ProviderCardBilling {
  line1: string;
  city: string;
  state: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  postalCode: string | null;
}

export interface ProviderAddMoneyStart {
  rail: AddMoneyRail;
  wallet: ProviderAddMoneyWallet;
  /** What the payer pays, in kobo. */
  chargeKobo: bigint;
  /** Ours: the payment intent's `reference`, the funding session's `unique_reference`. */
  reference: string;
  narration: string;
  /** An https address the provider sends the person back to after a hosted page. */
  returnUrl: string;
  /** ISO 3166-1 alpha-2 of the person's country. */
  countryCode: string;
  /** USSD only: the paying phone (international form) and the provider's channel for it. */
  ussd?: { msisdn: string; channel: string };
}

export interface ProviderAddMoneyConfirm {
  rail: 'card' | 'apple_pay';
  wallet: ProviderAddMoneyWallet;
  /** The payment intent `startAddMoney` made. */
  providerRef: string;
  returnUrl: string;
  payer: ProviderAddMoneyPayer;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  /**
   * A card payment: the card as the phone encrypted it with the provider's
   * public key (base64). Passed on as it is: never read, stored or logged.
   */
  encryptedCard?: string;
  billing?: ProviderCardBilling;
  browser?: ProviderCardBrowser;
}

/** One attempt as the provider records it. */
export interface ProviderAddMoneyAttempt {
  rail: AddMoneyRail;
  /** The payment intent's or the funding session's id. */
  providerRef: string;
  /** The confirming action's id (a card or Apple Pay payment). */
  actionRef: string | null;
  state: ProviderAddMoneyState;
  /** A hosted page to open: 3-D Secure, Apple Pay, the bank checkout. */
  nextUrl: string | null;
  /** The provider's charge in kobo, when its record says (the card's `applicable_fee`). */
  feeKobo: bigint | null;
  /** Why it failed, when it did: the provider's code and its own text, masked. */
  failure: { code: string; message: string } | null;
  card: { last4: string | null; brand: string | null } | null;
  expiresAt: Date | null;
}

export interface ProviderAddMoneyRef {
  rail: AddMoneyRail;
  wallet: ProviderAddMoneyWallet;
  providerRef: string;
}

/**
 * The add-money methods a provider may have. Each fails with a
 * `WalletProviderError`; `not_supported` says the provider does not take that
 * rail for this wallet's currency (Nuvion on dev: naira cards), and
 * `recordMayExist` that a payment may exist although the answer was lost.
 */
export interface AddMoneyProvider {
  /** Which rails this provider's adapter performs at all (not whether the account's currency is switched on). */
  readonly addMoneyRails: readonly AddMoneyRail[];
  /** Makes the payment intent (card, Apple Pay) or the funding session (USSD, bank checkout). Idempotent by `reference`. */
  startAddMoney(input: ProviderAddMoneyStart): Promise<ProviderAddMoneyAttempt>;
  /** Pays an intent with a card or Apple Pay. */
  confirmAddMoney(
    input: ProviderAddMoneyConfirm,
  ): Promise<ProviderAddMoneyAttempt>;
  /** Where one attempt stands now, asked of the provider. */
  readAddMoney(ref: ProviderAddMoneyRef): Promise<ProviderAddMoneyAttempt>;
  /** An attempt found again by our reference, or null when the provider has none. */
  findAddMoney(
    rail: AddMoneyRail,
    wallet: ProviderAddMoneyWallet,
    reference: string,
  ): Promise<ProviderAddMoneyAttempt | null>;
  /** Cancels an attempt that was not paid, where the provider can (a payment intent). */
  cancelAddMoney(ref: ProviderAddMoneyRef): Promise<void>;
}

/** The provider's add-money methods, or null when it has none (Fintava). */
export function addMoneyOf(
  provider: WalletProvider,
): (WalletProvider & AddMoneyProvider) | null {
  const p = provider as WalletProvider & Partial<AddMoneyProvider>;
  return Array.isArray(p.addMoneyRails) &&
    typeof p.startAddMoney === 'function' &&
    typeof p.confirmAddMoney === 'function' &&
    typeof p.readAddMoney === 'function' &&
    typeof p.findAddMoney === 'function' &&
    typeof p.cancelAddMoney === 'function'
    ? (provider as WalletProvider & AddMoneyProvider)
    : null;
}
