import { randomInt } from 'node:crypto';
import type { FintavaError } from '../fintava/fintava-error';
import { ledgerStatusOf } from '../fintava/fintava-ledger-delivery';
import type {
  FintavaAirtimeInput,
  FintavaBillReceipt,
  FintavaCableInput,
  FintavaCableProvider,
  FintavaDataInput,
  FintavaElectricityInput,
  FintavaNetwork,
  FintavaTransaction,
} from '../fintava/fintava.interface';
import type { BillCategory } from '../money/dto/money-enums';

/**
 * The rules of a bill paid from the wallet that need no database (task
 * BILLS-04). A bill is a `bill` wallet payment into WAWU's own account (R-19)
 * followed by a purchase at Fintava out of that account; the payment moves
 * `amount + bill charge + WAWU's bill fee` in one transfer (R-31) and the
 * purchase pays the biller the bill's own amount.
 */

/** A bill's states, as the row keeps them. */
export const BILL_STATUSES = [
  'draft',
  'buying',
  'delivered',
  'failed',
] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/** What the app is told: `awaiting_payment` is a draft, `processing` is paid and not yet settled either way. */
export type BillProgress =
  'awaiting_payment' | 'processing' | 'delivered' | 'failed';

export function progressOf(status: BillStatus): BillProgress {
  switch (status) {
    case 'draft':
      return 'awaiting_payment';
    case 'buying':
      return 'processing';
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'failed';
  }
}

export const NETWORKS: readonly FintavaNetwork[] = [
  'MTN',
  'GLO',
  'AIRTEL',
  '9MOBILE',
];
export const CABLE_PROVIDERS: readonly FintavaCableProvider[] = [
  'GOTV',
  'DSTV',
];

/** What a person reads for a network or a cable provider. */
export const BILLER_TITLES: Readonly<Record<string, string>> = {
  MTN: 'MTN',
  GLO: 'Glo',
  AIRTEL: 'Airtel',
  '9MOBILE': '9mobile',
  GOTV: 'GOtv',
  DSTV: 'DStv',
};

/** Airtime is whole naira and ₦100 or more (`docs/fintava/sandbox/19-`). */
export const AIRTIME_MINIMUM_KOBO = 10_000;

/** What the app is told when it asks about a bill that is not its own. */
export const BILL_NOT_FOUND_MESSAGE = 'We could not find that bill.';
export const BILL_ALREADY_PAID_MESSAGE =
  'This bill has already been paid. Start a new one to pay again.';
export const BILL_CHANGED_MESSAGE =
  'This bill is no longer available as it was. Start it again.';
/** A failed bill's words, by whether the refund has completed (it is a move of its own and can wait). */
export const BILL_FAILED_RETURNING_REASON =
  'The biller did not confirm the payment. Your money is on its way back to your wallet.';
export const BILL_FAILED_RETURNED_REASON =
  'The biller did not confirm the payment. Your money was returned to your wallet.';
/** What a person reads on paying a bill that failed again. */
export const BILL_FAILED_MESSAGE =
  'This bill did not go through. Start a new bill to try again.';

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The reference a person quotes: `WAW-BIL-` and eight characters nobody mistakes for another. */
export function newBillReference(): string {
  let tail = '';
  for (let i = 0; i < 8; i += 1) {
    tail += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `WAW-BIL-${tail}`;
}

/** The bill row's facts a purchase is made from. */
export interface BillSpec {
  category: BillCategory;
  billerCode: string;
  planType: 'prepaid' | 'postpaid' | null;
  productCode: string | null;
  accountNumber: string | null;
  amountKobo: number;
}

export type PurchaseInput =
  | { category: 'electricity'; input: FintavaElectricityInput }
  | { category: 'airtime'; input: FintavaAirtimeInput }
  | { category: 'data'; input: FintavaDataInput }
  | { category: 'cable'; input: FintavaCableInput };

/**
 * The call to Fintava for a bill. A row missing what its category needs is a
 * programming error (creation never writes one), so it throws and nothing is
 * sent.
 */
export function purchaseInputOf(bill: BillSpec): PurchaseInput {
  const account = bill.accountNumber;
  if (account === null) throw new Error('A bill without an account number.');
  switch (bill.category) {
    case 'electricity':
      if (bill.planType === null) throw new Error('A meter without a plan.');
      return {
        category: 'electricity',
        input: {
          meterNumber: account,
          disco: bill.billerCode,
          planType: bill.planType,
          amountKobo: bill.amountKobo,
        },
      };
    case 'airtime':
      return {
        category: 'airtime',
        input: {
          network: bill.billerCode as FintavaNetwork,
          phone: account,
          amountKobo: bill.amountKobo,
        },
      };
    case 'data':
      if (bill.productCode === null)
        throw new Error('A bundle without a code.');
      return {
        category: 'data',
        input: {
          network: bill.billerCode as FintavaNetwork,
          phone: account,
          bundleCode: bill.productCode,
        },
      };
    case 'cable':
      if (bill.productCode === null) throw new Error('A plan without a code.');
      return {
        category: 'cable',
        input: {
          provider: bill.billerCode as FintavaCableProvider,
          smartcardNumber: account,
          planCode: bill.productCode,
        },
      };
  }
}

const UNITS_KEYS = new Set([
  'units',
  'unit',
  'kwh',
  'unitspurchased',
  'unitsbought',
  'meterunits',
  'energyunits',
]);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A token or a unit count as it is shown: plain text, bounded, nothing but what Fintava said. */
function shown(v: string | number | boolean | null | undefined): string | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const text = String(v).trim();
  return text === '' || text.length > 64 ? null : text;
}

/**
 * The units bought (S7's "45.2 kWh"), from the scalar fields of Fintava's
 * purchase answer. Fintava documents none of its purchase answers (question 7
 * in `docs/fintava/naira-api.md`), so this reads the names an electricity
 * answer would carry and returns null when none is there; the app then shows
 * no units (BACKEND_GAPS G-647).
 */
export function unitsOf(details: FintavaBillReceipt['details']): string | null {
  for (const [key, value] of Object.entries(details)) {
    if (UNITS_KEYS.has(squash(key))) {
      const text = shown(value);
      if (text !== null) return text;
    }
  }
  return null;
}

/** The token of an electricity answer: the client's reading, else the token field of the details. */
export function tokenOf(receipt: FintavaBillReceipt): string | null {
  const direct = shown(receipt.meterToken);
  if (direct !== null) return direct;
  for (const [key, value] of Object.entries(receipt.details)) {
    if (['token', 'metertoken', 'pin'].includes(squash(key))) {
      const text = shown(value);
      if (text !== null) return text;
    }
  }
  return null;
}

/** How a record in Fintava's merchant history reads for one unknown purchase. */
export type HistoryReading =
  | { state: 'delivered'; row: FintavaTransaction }
  | { state: 'failed'; row: FintavaTransaction }
  /** One record matched and is still going, or several matched: not proof either way. */
  | { state: 'unknown' }
  | { state: 'none' };

/** Fintava's clock and ours may differ by this much when a record is matched to a purchase (seconds, never minutes). */
export const HISTORY_SKEW_MS = 10_000;

/** What already belongs to other bills, so a record settles at most one. */
export interface HistoryGuard {
  /** A record made before this moment is an earlier purchase's: the previous bill for the same meter or number and amount was delivered then. */
  notBefore?: Date | null;
  /** A record made after this moment is a later purchase's (for a bill that already failed: when it failed, plus the clock difference). */
  notAfter?: Date | null;
  /** Fintava transaction ids stored on another bill. */
  takenIds?: ReadonlySet<string>;
  /** Fintava references stored on another bill. */
  takenReferences?: ReadonlySet<string>;
}

/**
 * Finds the record of a purchase whose answer was lost, in Fintava's merchant
 * history. A record counts only when it was made at or after the purchase was
 * handed over (less a few seconds of clock difference, and never before the
 * previous bill for the same number and amount was delivered), is not already
 * on another bill, is at the bill's amount (or that plus the bill charge),
 * and, for electricity, is for the same meter; for the other three, when it
 * names the phone or smartcard number. Exactly one such record decides; none
 * is `none` (absence is never proof the purchase did not happen) and two or
 * more are `unknown` (never guessed between).
 */
export function readHistory(
  bill: BillSpec & { billChargeKobo: number },
  sentAt: Date,
  rows: readonly FintavaTransaction[],
  guard: HistoryGuard = {},
): HistoryReading {
  const since = Math.max(
    sentAt.getTime() - HISTORY_SKEW_MS,
    guard.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  const amounts = new Set([
    bill.amountKobo,
    bill.amountKobo + bill.billChargeKobo,
  ]);
  const account = bill.accountNumber ?? '';
  const tail = account.replace(/\D/g, '').slice(-9);
  const matches = rows.filter((r) => {
    if (Date.parse(r.createdAt) < since) return false;
    if (
      guard.notAfter != null &&
      Date.parse(r.createdAt) > guard.notAfter.getTime()
    ) {
      return false;
    }
    if (guard.takenIds?.has(r.id)) return false;
    if (
      r.fintavaReference !== null &&
      guard.takenReferences?.has(r.fintavaReference)
    ) {
      return false;
    }
    if (!amounts.has(r.amountKobo)) return false;
    if (bill.category === 'electricity') {
      return r.meterNumber !== null && r.meterNumber === account;
    }
    if (tail.length < 6) return false;
    const where = `${r.recipientDetails ?? ''} ${r.narration ?? ''}`.replace(
      /\D/g,
      '',
    );
    return where.includes(tail);
  });
  if (matches.length === 0) return { state: 'none' };
  if (matches.length > 1) return { state: 'unknown' };
  const row = matches[0];
  const status = ledgerStatusOf(row.status);
  if (status === 'completed') return { state: 'delivered', row };
  if (status === 'failed') return { state: 'failed', row };
  return { state: 'unknown' };
}

/**
 * Whether a failed purchase call certainly bought nothing, so the biller did
 * not deliver and the money goes back. Fintava's own refusals leave no record
 * (`recordMayExist` false: a 4xx, "Unable to find customers", no key). A 2xx
 * that is not a purchase is `not_confirmed` and may hide one, except the one
 * answer the sandbox gives cable with nothing debited, "service not currently
 * available" (`docs/fintava/sandbox/21-bills-cable.md`): the company's
 * service is off, which is a statement about the service and not about a
 * purchase. Every other 2xx without a purchase, a timeout and a 5xx stay
 * undecided.
 */
export function boughtNothing(e: FintavaError): boolean {
  if (!e.recordMayExist) return true;
  return (
    e.kind === 'not_confirmed' &&
    e.messages.some((m) => /service not currently available/i.test(m))
  );
}
