import type { PaymentKind, TransactionFilter } from '../dto/money-enums';
import type { TransactionCategory } from '../money-view.type';

/**
 * The words a history row is described with (W26, W27), in one place, so
 * the SQL that searches a description and the description the app is sent
 * are built from the same table (transaction-history.service.ts writes both
 * from these maps). Copy for the person: no em-dash, no provider name.
 *
 * A row's description is its label, then what it was for (the link's
 * title), then the bank when the other side is a bank account, joined with
 * " · " as W26 draws "Transfer · GTBank". A grouped row adds its count
 * ("Unlock · Lighting night shoots · 3 buyers").
 */

/** What each kind of movement is called when nothing more specific names it. */
export const CATEGORY_LABELS: Record<TransactionCategory, string> = {
  transfer: 'Transfer',
  top_up: 'Top up',
  earning: 'Earning',
  purchase: 'Payment',
  bill: 'Bill',
  hold: 'Held payment',
  refund: 'Refund',
  reversal: 'Reversal',
};

/** An earning or a purchase is named after what it paid for. */
export const LINK_LABEL_CATEGORIES: readonly TransactionCategory[] = [
  'earning',
  'purchase',
];

export const LINK_KIND_LABELS: Record<PaymentKind, string> = {
  content_unlock: 'Unlock',
  tip: 'Tip',
  credit_pack: 'Credits',
  verification: 'Verification',
  legal_fee: 'Legal fee',
  school_fee: 'School fee',
  paid_dm: 'Paid question',
  event_ticket: 'Event ticket',
  bill: 'Bill',
};

/** Between the parts of a description. */
export const DESCRIPTION_SEPARATOR = ' · ';

/**
 * What follows a grouped row's count (W26's "3 buyers"). A group always
 * holds two or more, and a piece is unlocked once per buyer, so the count is
 * the number of buyers.
 */
export const GROUP_COUNT_SUFFIX = ' buyers';

/**
 * The other side's name when the movement's record carries none. The app's
 * name is "Who Made This" (R-37): a movement with WAWU itself is shown so.
 */
export const COUNTERPARTY_FALLBACK_NAMES = {
  wawu_user: 'Someone on Who Made This',
  bank_account: 'Bank account',
  biller: 'Biller',
  wawu: 'Who Made This',
} as const;

/**
 * Which link kinds the "Content" chip shows: an unlock and a tip are both
 * money for content (W26 draws a tip as "Tip on your video"). Default
 * (agent), owner may override.
 */
export const CONTENT_LINK_KINDS: readonly PaymentKind[] = [
  'content_unlock',
  'tip',
];

/** What each filter chip keeps. `all` keeps everything. */
export type FilterRule =
  | { kind: 'all' }
  | { kind: 'direction'; direction: 'in' | 'out' }
  | { kind: 'bills' }
  | { kind: 'content' };

export const FILTER_RULES: Record<TransactionFilter, FilterRule> = {
  all: { kind: 'all' },
  money_in: { kind: 'direction', direction: 'in' },
  money_out: { kind: 'direction', direction: 'out' },
  bills: { kind: 'bills' },
  content: { kind: 'content' },
};
