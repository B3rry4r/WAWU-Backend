/**
 * Response shapes of the world wallet contract (task WALLET-41, R-87): a
 * person outside Nigeria opens a wallet without a BVN, in their own
 * currency. Money that is not naira is an integer in the currency's smallest
 * unit in a field ending `Minor`, always beside a currency field
 * (docs/contract/CONVENTIONS.md, "Amounts that are not naira"); a time is an
 * ISO 8601 UTC string.
 */
import type { FxFiatCode } from '../fx/fx-currencies';

/** One currency the person may open their first account in. */
export interface WorldCurrencyChoiceView {
  code: FxFiatCode;
  name: string;
  /** Places in the smallest unit. */
  decimals: number;
  /** False when an admin switched this currency off: not offered. */
  enabled: boolean;
}

/**
 * GET /money/world/options?country=XX: what a person living in that country
 * is offered before they open. Reads config and the admin switches only; the
 * provider is not called.
 */
export interface WorldOptionsView {
  /** The country asked about, upper case. */
  country: string;
  /** False for Nigeria (the BVN naira wallet is theirs, R-6). */
  abroad: boolean;
  /**
   * True when a wallet can be opened from this country now: the product is
   * on, the country is not held back and the day's cap is not reached.
   */
  available: boolean;
  /** Why not, when `available` is false: `switched_off`, `country_blocked`, `limit_reached`, `nigeria`. */
  unavailableReason:
    'switched_off' | 'country_blocked' | 'limit_reached' | 'nigeria' | null;
  /** The currency the country is first offered (config table, R-87). */
  suggested: FxFiatCode;
  /** Every currency the first account can be in; the person may pick any enabled one. */
  choices: WorldCurrencyChoiceView[];
  /** What WAWU charges to open, from config (default 0, R-10); quoted, see WorldSettings. */
  openFee: { currency: FxFiatCode; amountMinor: number };
}

/** The part of the wallet a person outside Nigeria has (WalletView.world). */
export interface WorldWalletView {
  /** ISO 3166-1 alpha-2, as sent when they opened. */
  country: string;
  /** The currency chosen for the first account. */
  firstCurrency: FxFiatCode | null;
  /**
   * `opening`: the review or the first account is not done (WalletView.review
   * says where); `open`: the first account is open (GET /money/fx/accounts);
   * `frozen`: an admin froze it; `cancelled`: an admin refused the opening.
   */
  state: 'opening' | 'open' | 'frozen' | 'cancelled';
  /** When the first account was opened; null before. */
  accountOpenedAt: string | null;
}

/** Admin: one world opening or wallet, as support reads it. No name, document or number. */
export interface AdminWorldOpeningView {
  wawuUserId: string;
  country: string;
  firstCurrency: FxFiatCode | null;
  /**
   * `started` (details in, no review yet), `needs_documents`, `checking`,
   * `rejected`, `approved` (waiting for the first account), `open`,
   * `stopped`, `expired`, `frozen`, `cancelled`.
   */
  stage: string;
  /** Nuvion's own review word (`incomplete`, `pending`, `approved` ...); null before an entity. */
  reviewStatus: string | null;
  frozenAt: string | null;
  frozenReason: string | null;
  cancelledAt: string | null;
  accountOpenedAt: string | null;
  createdAt: string;
}

export interface AdminWorldOpeningPage {
  items: AdminWorldOpeningView[];
  nextCursor: string | null;
}

export interface AdminWorldActView {
  wawuUserId: string;
  action: 'freeze' | 'unfreeze' | 'cancel';
  /** False when the person was already in that state: nothing changed, no audit row. */
  changed: boolean;
  stageBefore: string;
  stageAfter: string;
  /** Foreign accounts frozen or let go by this act. */
  accountsChanged: number;
}
