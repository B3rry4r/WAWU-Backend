import type { WaitlistRegistration } from '../../generated/prisma/client';
import {
  csvLine,
  nairaText,
  textCell,
} from '../money/statements/statement-csv';
import { accessCodeLabel } from './waitlist-contact';

/** The header cells of the team's CSV, in order. Naira only. */
export const WAITLIST_EXPORT_COLUMNS = [
  'Registered at',
  'Offer',
  'Status',
  'Full name',
  'Phone',
  'Email',
  'State',
  'What they make',
  'Fee (₦)',
  'Paid (₦)',
  'Refund due (₦)',
  'Paid at',
  'Access code',
  'Reference',
  'Transaction id',
  'Claimed',
  'Claimed at',
  // Appended after the columns the team already reads (JOIN-V2), so no
  // existing column moves.
  'Craft',
  'City',
  'Updates opt-in',
  // Appended after the columns the team already reads (REF-01), so no
  // existing column moves.
  'Referral code',
  'Community',
] as const;

export const WAITLIST_EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8';

export function waitlistHeaderLine(): string {
  return csvLine(WAITLIST_EXPORT_COLUMNS.map((c) => textCell(c)));
}

/**
 * One registration as a CSV line. Names, emails and the free-text fields come
 * from people, so every text cell goes through `textCell` (a cell a
 * spreadsheet would run as a formula is written with a `'` in front). Amounts
 * are naira with two decimals from integer kobo.
 *
 * "Paid (₦)" is what the registration is worth: it is empty on a `failed` row
 * (a second payment by someone already registered), whose money is not
 * revenue but is owed back, so a filter on a non-empty "Paid" cannot count a
 * refund as income. The same amount is in "Refund due (₦)", on `failed` rows
 * only. "Claimed" is `yes` once an account has claimed the plan in the app,
 * with the time beside it.
 */
export function waitlistLine(r: WaitlistRegistration): string {
  return csvLine(WAITLIST_EXPORT_COLUMNS.map((column) => CELLS[column](r)));
}

type Column = (typeof WAITLIST_EXPORT_COLUMNS)[number];

/**
 * One cell per header, keyed by the header itself, so a row is built FROM the
 * header list and cannot drift from it: add a column to the list and the
 * compiler asks for its cell; move one and its cell moves with it.
 */
const CELLS: Record<Column, (r: WaitlistRegistration) => string> = {
  'Registered at': (r) => r.createdAt.toISOString(),
  Offer: (r) => textCell(r.offerId),
  Status: (r) => r.status,
  'Full name': (r) => textCell(r.fullName),
  Phone: (r) => textCell(r.phone),
  Email: (r) => textCell(r.email),
  State: (r) => textCell(r.state),
  'What they make': (r) => textCell(r.makes),
  'Fee (₦)': (r) => nairaText(r.amountKobo),
  'Paid (₦)': (r) =>
    r.paidKobo === null || r.status === 'failed' ? '' : nairaText(r.paidKobo),
  'Refund due (₦)': (r) =>
    r.paidKobo !== null && r.status === 'failed' ? nairaText(r.paidKobo) : '',
  'Paid at': (r) => r.paidAt?.toISOString() ?? '',
  'Access code': (r) => textCell(accessCodeLabel(r.accessCode)),
  Reference: (r) => textCell(r.reference),
  'Transaction id': (r) => textCell(r.flutterwaveTxId),
  Claimed: (r) => (r.claimedByWawuId === null ? 'no' : 'yes'),
  'Claimed at': (r) => r.claimedAt?.toISOString() ?? '',
  Craft: (r) => textCell(r.craft),
  City: (r) => textCell(r.city),
  'Updates opt-in': (r) =>
    r.updatesOptIn === null ? '' : r.updatesOptIn ? 'yes' : 'no',
  'Referral code': (r) => textCell(r.referralCode),
  Community: (r) => textCell(r.referralCommunity),
};
