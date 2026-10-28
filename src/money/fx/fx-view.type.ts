/**
 * Response shapes of the foreign-currency contract (task WALLET-21, R-83,
 * R-84): dollar and other currency accounts, stablecoin accounts, swaps and
 * crypto sends, on Nuvion.
 *
 * Units, everywhere in this file (docs/contract/CONVENTIONS.md, "Amounts that
 * are not naira"):
 * - money that is not naira is an integer in the currency's smallest unit, in
 *   a field whose name ends `Minor`, always beside a currency field (a WAWU
 *   code: USD, EUR, GBP, CAD, AED, GHS, USDT, USDC, RLUSD). `decimals` on the
 *   currency says how many places that unit has;
 * - naira stays kobo, in a field ending `Kobo`;
 * - a time is an ISO 8601 UTC string.
 * A balance is the provider's, read on every request, never a sum of our rows.
 */

import type {
  FxChain,
  FxCurrencyCode,
  FxKind,
  FxQuoteCode,
} from './fx-currencies';

/** The three products an admin can switch off one by one. */
export interface FxProductsView {
  /** Opening a new foreign or stablecoin account. */
  openAccount: boolean;
  /** Swapping between two of the person's accounts. */
  swap: boolean;
  /** Sending USDT, USDC or RLUSD to an outside address. */
  cryptoSend: boolean;
}

export interface FxCurrencyView {
  code: FxCurrencyCode;
  name: string;
  kind: FxKind;
  /** Places in the smallest unit (2 for a dollar's cent). */
  decimals: number;
  /** The chains a stablecoin can be held on; empty for a fiat currency. */
  chains: FxChain[];
  /** False when an admin switched this currency off: no new account, swap or send in it. */
  enabled: boolean;
}

export interface FxCurrenciesView {
  currencies: FxCurrencyView[];
  products: FxProductsView;
  /** The naira wallet, which a swap can start from or end in. */
  naira: { code: 'NGN'; decimals: 2 };
}

/** What Nuvion issued for people to pay into the account. Fields not issued are null. */
export interface FxReceivingDetailsView {
  /** `pending` while Nuvion provisions it; the numbers appear when it is `active`. */
  status: 'pending' | 'active';
  /** Fiat: the account holder's name as a payer's bank shows it. */
  beneficiaryName: string | null;
  /** Fiat: account number (US, UK, GHS ...). */
  accountNumber: string | null;
  /** Fiat: US ACH and wire routing number. */
  routingNumber: string | null;
  swiftCode: string | null;
  iban: string | null;
  sortCode: string | null;
  bankName: string | null;
  bankAddress: string | null;
  /** Stablecoin: the chain this account's one wallet address is on. */
  chain: FxChain | null;
  /** Stablecoin: the wallet address. */
  address: string | null;
}

/** An account's balance as the provider reports it. */
export interface FxBalanceView {
  currency: FxCurrencyCode;
  /** What can be spent. The only figure a person is shown. */
  availableMinor: number;
  /** Including what is pending settlement. */
  bookedMinor: number;
}

export interface FxAccountView {
  id: string;
  currency: FxCurrencyCode;
  kind: FxKind;
  decimals: number;
  /** A stablecoin account is one chain's; null for a fiat account. */
  chain: FxChain | null;
  /** `frozen`: an admin froze it; money can arrive but not leave. */
  status: 'opening' | 'open' | 'frozen';
  /** The provider's balance; null when the provider could not be asked (try again). */
  balance: FxBalanceView | null;
  details: FxReceivingDetailsView | null;
  /**
   * Where the receiving details stand: `ready` (issued and active), `pending`
   * (the provider is issuing them), or `unavailable` (the provider would not
   * issue them just now: `detailsNote` has its words). The app says exactly
   * this and promises nothing about when they arrive.
   */
  detailsStatus: 'ready' | 'pending' | 'unavailable';
  /** With `unavailable`: the provider's own words; null otherwise. */
  detailsNote: string | null;
  openedAt: string;
}

export interface FxAccountListView {
  accounts: FxAccountView[];
}

/** One line of an account's history, read from the provider's statement. */
export interface FxTransactionView {
  id: string;
  accountId: string;
  currency: FxCurrencyCode;
  direction: 'in' | 'out';
  status: 'completed' | 'pending' | 'failed' | 'reversed';
  /** What moved, before the fee. */
  amountMinor: number;
  /** What the provider took on top. */
  feeMinor: number;
  /** The account's balance right after, when the statement says. */
  balanceAfterMinor: number | null;
  /** For a line WAWU made (a payment, its conversion fee, a refund) what it was for, as the naira history words it ("Unlock · the title"). */
  description: string;
  /** The provider's name for the other side; "Who Made This" for a line WAWU made, never one of WAWU's own account names (FIX-P6 L2). */
  counterpartyName: string | null;
  reference: string;
  occurredAt: string;
  /** Set when the line was a conversion. */
  conversion: FxConversionView | null;
}

export interface FxConversionView {
  fromCurrency: FxQuoteCode;
  toCurrency: FxQuoteCode;
  /** The provider's rate: units of `toCurrency` per unit of `fromCurrency`, both smallest units. */
  rate: string;
  fromMinor: number;
  toMinor: number;
}

export interface FxTransactionPage {
  items: FxTransactionView[];
  /** Pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}

/** A quote for converting one amount, held for the provider's real expiry. */
export interface FxQuoteView {
  /** Ours. Pass it as `quoteId` to swap. */
  id: string;
  fromCurrency: FxQuoteCode;
  toCurrency: FxQuoteCode;
  /** The account debited; null when it is the naira wallet. */
  fromAccountId: string | null;
  /** The account credited; null when it is the naira wallet. */
  toAccountId: string | null;
  /** In the smallest unit of `fromCurrency`; kobo when that is NGN. */
  amountFromMinor: number;
  /** In the smallest unit of `toCurrency`; kobo when that is NGN. */
  amountToMinor: number;
  fromDecimals: number;
  toDecimals: number;
  /** The provider's rate in smallest units: `amountToMinor / amountFromMinor`. */
  rate: string;
  /**
   * The provider's charge on the quote, shown before the PIN: the quote's own figure if the provider names one, else the
   * configured one (`FX_SWAP_PROVIDER_FEE_<CODE>_MINOR`, 0 unless set; a book transfer between a person's own accounts cost 0
   * on dev). Every quote the Hub makes now carries a number (WALK4-FIX L-1); the type stays nullable for a quote saved before.
   * The receipt carries what the provider really charged.
   */
  providerFeeMinor: number | null;
  /** WAWU's fee on top, in `fromCurrency`'s smallest unit (config, R-10; 0 until the owner names it). */
  wawuFeeMinor: number;
  /** What leaves the `from` account: the amount plus the bank's charge (if named) plus WAWU's fee. */
  totalFromMinor: number;
  /** When the provider stops honouring the rate. */
  expiresAt: string;
  /** Seconds left now. */
  validForSeconds: number;
}

export type FxOperationStatus = 'pending' | 'completed' | 'failed';

export interface FxSwapView {
  id: string;
  status: FxOperationStatus;
  fromCurrency: FxQuoteCode;
  toCurrency: FxQuoteCode;
  fromAccountId: string | null;
  toAccountId: string | null;
  amountFromMinor: number;
  amountToMinor: number;
  fromDecimals: number;
  toDecimals: number;
  rate: string;
  /** What the provider charged; null until it has said. */
  providerFeeMinor: number | null;
  wawuFeeMinor: number;
  /** Plain words when it failed (nothing moved); null otherwise. */
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** What a send to an outside address would cost, before the PIN. */
export interface FxSendQuoteView {
  accountId: string;
  currency: FxCurrencyCode;
  chain: FxChain;
  decimals: number;
  amountMinor: number;
  /**
   * The provider's network fee. The provider names it only when it takes the
   * send (null here); the receipt shows what it charged, in `currency`, on top.
   */
  providerFeeMinor: number | null;
  wawuFeeMinor: number;
  /** The most the account holds now (the provider's balance), for a Max button. */
  availableMinor: number;
}

export interface FxSendView {
  id: string;
  status: FxOperationStatus;
  accountId: string;
  currency: FxCurrencyCode;
  chain: FxChain;
  decimals: number;
  /** The outside address the coins went to. */
  address: string;
  amountMinor: number;
  /** What the provider charged on top; null until it has said. */
  providerFeeMinor: number | null;
  wawuFeeMinor: number;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/* ------------------------------ admin ------------------------------ */

export interface AdminFxAccountView extends FxAccountView {
  wawuUserId: string;
  /** Set while an admin has it frozen. */
  frozenAt: string | null;
  frozenReason: string | null;
}

export interface AdminFxAccountListView {
  wawuUserId: string;
  accounts: AdminFxAccountView[];
}

export interface AdminFxOperationView {
  id: string;
  kind: 'swap' | 'send';
  status: FxOperationStatus;
  wawuUserId: string;
  fromCurrency: FxQuoteCode;
  toCurrency: FxQuoteCode | null;
  amountFromMinor: number;
  amountToMinor: number | null;
  providerFeeMinor: number | null;
  wawuFeeMinor: number;
  /**
   * WAWU's fee on the operation: `done` (collected, confirmed by the provider),
   * `owed` (still to be collected), `uncollected` (refused three times and given
   * back: `wawuFeeMinor` is then 0), or null when there was no fee.
   */
  feeLeg: 'done' | 'owed' | 'uncollected' | null;
  /** A send's chain and address; null on a swap. */
  chain: FxChain | null;
  address: string | null;
  reference: string;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminFxOperationPage {
  items: AdminFxOperationView[];
  nextCursor: string | null;
}

export interface AdminFxFreezeView {
  accountId: string;
  wawuUserId: string;
  status: 'open' | 'frozen';
  frozenAt: string | null;
  frozenReason: string | null;
}

/**
 * One currency as the dashboard reads it (task OPS-27, R-83, R-84): the
 * catalogue line with its places in the smallest unit as the Hub counts them
 * (a coin's can be set by config), the switch, and the figures WAWU sets in
 * config (R-10). Read only: nothing here changes a figure.
 */
export interface AdminFxCurrencyView extends FxCurrencyView {
  /** The currency the three figures below are in (the same code as `code`), beside every Minor field. */
  currency: FxCurrencyCode;
  /** WAWU's fee on a swap out of this currency, in its smallest unit; 0 when none is set. */
  swapFeeMinor: number;
  /** WAWU's fee on a crypto send, in its smallest unit; 0 for a fiat currency and when none is set. */
  sendFeeMinor: number;
  /** The most one person may move out of this currency in a Lagos day; null is no limit of WAWU's own. */
  dailyLimitMinor: number | null;
}

export interface AdminFxCurrenciesView {
  currencies: AdminFxCurrencyView[];
  products: FxProductsView;
  /** The naira side of a swap, in kobo. */
  naira: {
    code: 'NGN';
    decimals: 2;
    swapFeeKobo: number;
    dailyLimitKobo: number | null;
  };
}
