import type { ReceiptTone } from '../../styles/tokens-receipt';
import {
  COUNTERPARTY_FALLBACK_NAMES,
  DESCRIPTION_SEPARATOR,
} from '../history/history-labels';
import type {
  TransactionCounterpartyView,
  TransactionView,
  TransferStatus,
} from '../money-view.type';
import type {
  ReceiptLineView,
  ReceiptPartyView,
  ReceiptView,
} from './receipt-view.type';

/**
 * What a receipt says, in words, from one transaction (task WALLET-18).
 * Pure functions: the owner's view, the printed document (image and PDF)
 * and the public page are all built here, so they say the same thing.
 * Copy for the person: no em-dash, naira only.
 */

/** The owner's own side when their wallet has no account name on record (W27 draws "To · Naira wallet"). */
export const OWN_WALLET_FALLBACK_NAME = 'Naira wallet';

export const RECEIPT_TITLE = 'TRANSACTION RECEIPT';

/** The row that proves the movement: drawn whole, never cut (receipt-render.ts). */
export const REFERENCE_LABEL = 'Reference';

export const STATUS_WORDS: Record<TransferStatus, string> = {
  completed: 'Completed',
  pending: 'Pending',
  failed: 'Failed',
  reversed: 'Reversed',
};

export const STATUS_TONES: Record<TransferStatus, ReceiptTone> = {
  completed: 'positive',
  pending: 'warning',
  failed: 'danger',
  reversed: 'danger',
};

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "26 Sep 2026, 10:24", in Africa/Lagos time (UTC+1, no daylight saving). */
export function receiptDate(iso: string): string {
  const t = new Date(Date.parse(iso) + 60 * 60_000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
}

/** Kobo as naira: 200000 is "₦2,000.00". Integers only, never a float on the way. */
export function naira(kobo: number): string {
  if (!Number.isSafeInteger(kobo))
    throw new RangeError('kobo must be a whole number');
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${kobo < 0 ? '−' : ''}₦${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** "812 345 6789": a NUBAN as W41 prints it. */
export function spacedAccount(account: string): string {
  return /^\d{10}$/.test(account)
    ? `${account.slice(0, 3)} ${account.slice(3, 6)} ${account.slice(6)}`
    : account;
}

export function lastFour(account: string | null | undefined): string | null {
  const digits = (account ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** "Tip", "Transfer": the label MONEY-15's description starts with. */
export function typeLabelOf(tx: TransactionView): string {
  return tx.description.split(DESCRIPTION_SEPARATOR)[0] || 'Transaction';
}

/** The owner's wallet as the receipt needs it. */
export interface OwnWallet {
  accountNumber: string;
  accountName: string | null;
}

function ownParty(wallet: OwnWallet): ReceiptPartyView {
  return {
    name: wallet.accountName?.trim() || OWN_WALLET_FALLBACK_NAME,
    accountNumber: wallet.accountNumber,
    accountNumberLast4: null,
    bankName: null,
  };
}

function otherParty(
  cp: TransactionCounterpartyView | null,
): ReceiptPartyView | null {
  if (!cp) return null;
  return {
    name: maskDigits(cp.name),
    accountNumber: null,
    accountNumberLast4: cp.accountNumberLast4,
    bankName: cp.bankName ? maskDigits(cp.bankName) : null,
  };
}

/** Who paid and who was paid: the owner is `to` on money in and `from` on money out. */
export function partiesOf(
  tx: TransactionView,
  wallet: OwnWallet,
): { from: ReceiptPartyView | null; to: ReceiptPartyView | null } {
  const own = ownParty(wallet);
  const other = otherParty(tx.counterparty);
  return tx.direction === 'in'
    ? { from: other, to: own }
    : { from: own, to: other };
}

/** "Lennox Emmanuel · 812 345 6789", "Chidinma Okoro · GTBank •••• 6789". */
export function partyText(p: ReceiptPartyView): string {
  const account = p.accountNumber
    ? spacedAccount(p.accountNumber)
    : [p.bankName, p.accountNumberLast4 ? `•••• ${p.accountNumberLast4}` : null]
        .filter(Boolean)
        .join(' ');
  return account ? `${p.name}${DESCRIPTION_SEPARATOR}${account}` : p.name;
}

/** "Tip from Amaka Nwosu", "Transfer to Chidinma Okoro", or the label alone. */
export function headlineOf(tx: TransactionView): string {
  const label = typeLabelOf(tx);
  const cp = tx.counterparty;
  if (!cp) return label;
  return `${label} ${tx.direction === 'in' ? 'from' : 'to'} ${maskDigits(cp.name)}`;
}

/**
 * The rows under the amount (W41: Type, From, To, Bank, Reference). A
 * money-out row adds what it cost (designer brief W12 and W27, R-10): the
 * amount, Fintava's charge, WAWU's fee when there is one, and the total.
 */
export function receiptLines(
  tx: TransactionView,
  parties: { from: ReceiptPartyView | null; to: ReceiptPartyView | null },
  bankName: string,
): ReceiptLineView[] {
  const lines: ReceiptLineView[] = [{ label: 'Type', value: typeLabelOf(tx) }];
  if (parties.from)
    lines.push({ label: 'From', value: partyText(parties.from) });
  if (parties.to) lines.push({ label: 'To', value: partyText(parties.to) });
  lines.push({ label: 'Bank', value: bankName });
  if (tx.direction === 'out') {
    lines.push({ label: 'Amount', value: naira(tx.amountKobo) });
    lines.push({
      label: "Fintava's charge",
      value: naira(tx.fee.providerFeeKobo),
    });
    if (tx.fee.wawuFeeKobo > 0)
      lines.push({ label: "WAWU's fee", value: naira(tx.fee.wawuFeeKobo) });
    lines.push({ label: 'Total paid', value: naira(tx.totalKobo) });
  }
  lines.push({ label: REFERENCE_LABEL, value: tx.reference });
  return lines;
}

/** The big figure: "+₦2,000.00" for money in, "₦25,000.00" for money out. */
export function amountText(tx: TransactionView): string {
  return `${tx.direction === 'in' ? '+' : ''}${naira(tx.amountKobo)}`;
}

/** Everything the image and the PDF draw, from the owner's view. */
export interface ReceiptDocument {
  title: string;
  dateText: string;
  headline: string;
  amountText: string;
  amountTone: ReceiptTone;
  statusText: string;
  statusTone: ReceiptTone;
  lines: ReceiptLineView[];
  footer: string;
  url: string | null;
}

export function receiptDocument(view: ReceiptView): ReceiptDocument {
  const tx = view.transaction;
  return {
    title: RECEIPT_TITLE,
    dateText: receiptDate(tx.createdAt),
    headline: view.headline,
    amountText: amountText(tx),
    amountTone: tx.direction === 'in' ? 'positive' : 'ink',
    statusText: STATUS_WORDS[tx.status],
    statusTone: STATUS_TONES[tx.status],
    lines: view.lines,
    footer: [`Check it at ${view.link}`, view.licenceLine]
      .filter(Boolean)
      .join(DESCRIPTION_SEPARATOR),
    url: view.url,
  };
}

/* ------------------------------------------------------------------ */
/* The public page: only what proves the movement                      */
/* ------------------------------------------------------------------ */

const FALLBACK_NAMES = new Set<string>(
  Object.values(COUNTERPARTY_FALLBACK_NAMES),
);

/** Where each run of decimal digits starts, for digitValue. */
const DECIMAL = /\p{Nd}/u;

/**
 * The value of any Unicode decimal digit (Arabic-Indic, Persian,
 * Devanagari, ...). Unicode keeps every set of decimal digits as ten
 * consecutive code points from 0 to 9, so the value is the distance from
 * the start of its run of digits, modulo 10 (sets can sit back to back, as
 * the mathematical digits do).
 */
function digitValue(ch: string): number {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (start > 0 && DECIMAL.test(String.fromCodePoint(start - 1))) start -= 1;
  return (cp - start) % 10;
}

/**
 * Text with every digit written 0 to 9: NFKC first (full-width,
 * superscript, circled and mathematical digits become ordinary ones), then
 * every other decimal digit by its value.
 */
export function foldDigits(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Nd}/gu, (d) =>
      d >= '0' && d <= '9' ? d : String(digitValue(d)),
    );
}

/**
 * One number, however it is written: digits joined by anything that is not
 * a letter (spaces, punctuation, dashes, dots, underscores, commas,
 * symbols, zero-width and other format characters), or by a single x or X
 * between two digits ("0803x123x4567"). A leading + or ( belongs to it.
 * Digits split by other letters are separate numbers.
 */
const NUMBER = /[+(]?\d(?:(?:[^\p{L}\d]|(?<=\d)[xX](?=\d))*\d)*/gu;

/**
 * Any phone-, meter- or account-like number keeps only its last 4 digits:
 * a number of 5 or more digits, in any script and with any separators
 * (NUMBER), becomes "•••• 4567". Text that is not a number keeps its
 * letters (NFKC-normalised). A date or an amount written into a name is a
 * number too and is reshaped the same way (Default (agent), owner may
 * override): only names are passed here, never the page's own amount,
 * date or reference.
 */
export function maskDigits(text: string): string {
  return foldDigits(text).replace(NUMBER, (run) => {
    const digits = run.replace(/\D/g, '');
    return digits.length >= 5 ? `•••• ${digits.slice(-4)}` : run;
  });
}

/**
 * A person's name as the public page shows it: the first name and the
 * other names' initials ("Amaka N."). A company the movement paid (a
 * biller, Who Made This) keeps its name. A handle is never shown: the
 * page says only that it was someone on Who Made This.
 */
export function maskedName(
  name: string,
  kind: TransactionCounterpartyView['kind'] | 'owner',
): string {
  const t = name.trim();
  if (FALLBACK_NAMES.has(t) || t === OWN_WALLET_FALLBACK_NAME) return t;
  if (t.startsWith('@') || t === '')
    return COUNTERPARTY_FALLBACK_NAMES.wawu_user;
  if (kind === 'biller' || kind === 'wawu') return maskDigits(t);
  const [first, ...rest] = maskDigits(t).split(/\s+/);
  const initials = rest
    .map((w) => w.replace(/^[^\p{L}]+/u, '').charAt(0))
    .filter(Boolean)
    .map((c) => `${c.toUpperCase()}.`);
  return [first, ...initials].join(' ');
}

/** One side on the public page: a masked name and at most the last 4 digits of an account. */
export interface PublicReceiptParty {
  name: string;
  account: string | null;
}

/** What the public page shows: the amount, date, status, masked parties and reference. Nothing else. */
export interface PublicReceipt {
  typeLabel: string;
  direction: 'in' | 'out';
  amountText: string;
  amountTone: ReceiptTone;
  statusText: string;
  statusTone: ReceiptTone;
  dateText: string;
  reference: string;
  from: PublicReceiptParty | null;
  to: PublicReceiptParty | null;
  bankName: string;
  licenceLine: string | null;
  link: string;
}

export function publicReceipt(
  tx: TransactionView,
  wallet: OwnWallet,
  bankName: string,
  licenceLine: string | null,
  link: string,
): PublicReceipt {
  const own: PublicReceiptParty = {
    name: maskedName(wallet.accountName ?? OWN_WALLET_FALLBACK_NAME, 'owner'),
    account: lastFour(wallet.accountNumber)
      ? `${maskDigits(bankName)} •••• ${lastFour(wallet.accountNumber)}`
      : null,
  };
  const cp = tx.counterparty;
  const other: PublicReceiptParty | null = cp
    ? {
        name: maskedName(cp.name, cp.kind),
        account: cp.accountNumberLast4
          ? [
              cp.bankName && maskDigits(cp.bankName),
              `•••• ${cp.accountNumberLast4}`,
            ]
              .filter(Boolean)
              .join(' ')
          : null,
      }
    : null;
  return {
    typeLabel: typeLabelOf(tx),
    direction: tx.direction,
    amountText: amountText(tx),
    amountTone: tx.direction === 'in' ? 'positive' : 'ink',
    statusText: STATUS_WORDS[tx.status],
    statusTone: STATUS_TONES[tx.status],
    dateText: receiptDate(tx.createdAt),
    reference: tx.reference,
    from: tx.direction === 'in' ? other : own,
    to: tx.direction === 'in' ? own : other,
    bankName: maskDigits(bankName),
    licenceLine,
    link,
  };
}
