import type { FeeBreakdown } from '../money-view.type';

/** The two cards Nuvion issues for people today (R-84): reusable, and one payment only. */
export type CardKind = 'virtual' | 'single_use';

/**
 * `pending`: asked for, the issuer has not confirmed it yet (nothing is made
 * twice). `frozen`: no payment goes through until it is unfrozen. `blocked`:
 * stopped for good (the issuer soft-deletes it); it cannot be used or brought
 * back. `used`: a single-use card that Nuvion blocked after its one payment; it
 * cannot be frozen, unfrozen or shown again.
 */
export type CardStatus = 'pending' | 'active' | 'frozen' | 'blocked' | 'used';

/** One card of the person's (W29, W31, W32). Never the number, the expiry or the CVV. */
export interface CardView {
  id: string;
  kind: CardKind;
  /** What the person calls it. */
  name: string;
  status: CardStatus;
  currency: 'USD';
  /** True when support froze it: the person cannot unfreeze it. */
  frozenBySupport: boolean;
  /** The last four digits when the issuer lists them; null otherwise. The full number is shown only behind the PIN. */
  last4: string | null;
  /** A sentence for the person while the status is `pending`; null otherwise. */
  statusMessage: string | null;
  createdAt: string;
}

/** GET /money/cards. */
export interface CardListView {
  /** False while the product is switched off: the app draws nothing for cards. */
  enabled: boolean;
  /** Newest first. Failed requests are not listed. */
  cards: CardView[];
}

/** GET /money/cards/quote: what getting a card costs and whether the person may now (W29). */
export interface CardQuoteView {
  enabled: boolean;
  currency: 'USD';
  kinds: CardKind[];
  /** Nuvion's fee plus WAWU's, taken from the wallet when the card is made (R-10). */
  fee: FeeBreakdown;
  limits: {
    maxActive: number;
    maxPerDay: number;
    activeNow: number;
    askedToday: number;
  };
  /** True when a card can be asked for: the product is on, the fee is set and the person is under the limits. */
  canCreate: boolean;
}

/** POST /money/cards/{id}/reveal: shown on screen, never stored by WAWU. */
export interface CardDetailsView {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  cardholderName: string;
  billing: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  } | null;
}

/** One payment, reversal or refund on a card. */
export interface CardTransactionView {
  id: string;
  kind: 'purchase' | 'reversal' | 'refund';
  /** Cents of `currency`. */
  amountCents: number;
  currency: string;
  merchant: string | null;
  place: string | null;
  narration: string | null;
  status: string;
  /** When it happened (ISO 8601); null when the issuer gave no time. */
  occurredAt: string | null;
}

/** GET /money/cards/{id}/transactions. `nextCursor` null means the last page. */
export interface CardTransactionPage {
  items: CardTransactionView[];
  nextCursor: string | null;
}

/** A card as support sees it (admin/money/cards): by account id, never a name, number or phone. */
export interface AdminCardView {
  id: string;
  wawuUserId: string;
  kind: CardKind;
  state: string;
  frozenBy: string | null;
  providerCardId: string | null;
  createdAt: string;
  cancelledAt: string | null;
}

export interface AdminCardPage {
  items: AdminCardView[];
  nextCursor: string | null;
}

/**
 * What is in force for the WAWU card, for the dashboard (task OPS-27, R-10,
 * R-84). Read only: the switch is the admin setting `cards.enabled`; the fees
 * and the two counts come from config.
 */
export interface AdminCardSettingsView {
  /** The switch: off closes new cards (a card a person holds can still be frozen or blocked). */
  enabled: boolean;
  /** Nuvion's fee for making a card, in kobo; null while it is not set (making a card is then refused). */
  providerFeeKobo: number | null;
  /** WAWU's own fee on top, in kobo; 0 until the owner names it. */
  wawuFeeKobo: number;
  /** Cards a person may hold at once. */
  maxActive: number;
  /** Cards a person may ask for in a Lagos day. */
  maxPerDay: number;
}
