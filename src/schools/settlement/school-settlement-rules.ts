/**
 * The rules of paying a school its share of a course fee that need no
 * database (task SCHOOLS-11, R-12, R-10, R-31).
 */

export const SETTLEMENT_ACTIONS = ['payout', 'refund'] as const;
export type SettlementAction = (typeof SETTLEMENT_ACTIONS)[number];

export const SETTLEMENT_STATUSES = [
  'pending',
  'sent',
  'paid',
  'refunded',
  'review',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * Why nothing has moved yet on a settlement that is waiting:
 * `no_payee`: the school has no bank account the bank confirmed (an admin
 * sets one; the payout goes within a minute of that);
 * `provider`: the provider is out of reach, or the request provably never
 * reached it; `funds`: the provider says WAWU's own account cannot cover the
 * send; `refused`: the provider refused it and nothing moved.
 */
export const SETTLEMENT_WAITING = [
  'no_payee',
  'provider',
  'funds',
  'refused',
] as const;
export type SettlementWaiting = (typeof SETTLEMENT_WAITING)[number];

/** What the ledger row of a payout the bank did not complete says. No provider name. */
export const PAYOUT_FAILED_REASON = 'The bank did not complete this transfer.';

/** How many references one payout may use: the first, and one retry after a proved failure. */
export const MAX_ATTEMPT = 2;

/**
 * Our reference at the provider for one try of one payout. It begins with
 * `wawu-bank-` (BANK_SEND_REFERENCE_PREFIX) so the provider's adapter can find
 * a bank send again by its reference alone; `sch` names the school fee. A
 * first try is 50 characters and a retry 52, inside Nuvion's 64.
 */
export function payoutReference(settlementId: string, attempt: number): string {
  const base = `wawu-bank-sch-${settlementId}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/** What the bank statement of the school reads. Names nobody. */
export const PAYOUT_NARRATION = 'WAWU school fee';

const MINUTE = 60_000;

/** The rest before the next try or question: 1, 2, 4 ... minutes, at most an hour. */
export function restMs(count: number): number {
  return Math.min(60, 2 ** Math.min(Math.max(count, 0), 6)) * MINUTE;
}

/** The two shares add up to the fee, to the kobo (the database holds it too). */
export function sharesAddUp(row: {
  priceKobo: number;
  schoolShareKobo: number;
  wawuShareKobo: number;
}): boolean {
  return (
    Number.isSafeInteger(row.priceKobo) &&
    Number.isSafeInteger(row.schoolShareKobo) &&
    Number.isSafeInteger(row.wawuShareKobo) &&
    row.schoolShareKobo >= 0 &&
    row.wawuShareKobo >= 0 &&
    row.schoolShareKobo + row.wawuShareKobo === row.priceKobo
  );
}

/** What an admin reads. No em-dash, no provider name. */
export const SETTLEMENT_MESSAGES = {
  noSuchEnrolment: 'We could not find that enrolment.',
  noSuchIntake: 'We could not find that class.',
  noSuchSchool: 'We could not find that school.',
  notPaid: 'This enrolment has no paid fee to send back.',
  alreadyPaidOut:
    "This enrolment's fee has already been paid to the school, so it cannot be refunded from here.",
  payoutStarted:
    "This enrolment's fee is already on its way to the school, so it cannot be refunded from here.",
  alreadyRefunding: 'This enrolment is already being refunded.',
  payeeNotConfirmed:
    'The bank did not confirm that account. Check the bank and the account number and try again.',
  bankUnknown: 'That bank is not one we can pay.',
  bankUnreachable:
    "We couldn't reach the bank to check the account. Try again in a moment.",
} as const;
