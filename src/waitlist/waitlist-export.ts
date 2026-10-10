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
  'Paid at',
  'Access code',
  'Reference',
  'Transaction id',
  'Claimed at',
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
 */
export function waitlistLine(r: WaitlistRegistration): string {
  return csvLine([
    r.createdAt.toISOString(),
    textCell(r.offerId),
    r.status,
    textCell(r.fullName),
    textCell(r.phone),
    textCell(r.email),
    textCell(r.state),
    textCell(r.makes),
    nairaText(r.amountKobo),
    r.paidKobo === null ? '' : nairaText(r.paidKobo),
    r.paidAt?.toISOString() ?? '',
    textCell(accessCodeLabel(r.accessCode)),
    textCell(r.reference),
    textCell(r.flutterwaveTxId),
    r.claimedAt?.toISOString() ?? '',
  ]);
}
