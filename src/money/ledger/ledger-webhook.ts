/**
 * Reading MONEY-07's stored Fintava deliveries as ledger movements (task
 * MONEY-10). Pure: no database, no Fintava call, so every rule here is
 * unit-tested on its own.
 *
 * The payloads are Fintava's documented examples (mobile repo
 * `docs/fintava/reference/webhook-events.md`); no real delivery has been
 * received (no tunnel, R-25). Wherever the docs leave a field's meaning
 * open, both readings are kept and the choice is written beside it as
 * "Default (agent), owner may override".
 *
 * Amounts become kobo here, once, through the MONEY-06 helper
 * (`fintavaAmountToKobo`): decimal text, never float arithmetic, and a
 * value with more than 2 decimals is refused, not rounded.
 */
import {
  FintavaAmountError,
  fintavaAmountToKobo,
  fintavaAmountToKoboOrNull,
} from '../../fintava/fintava-amount';
import type { TransactionCategory, TransferStatus } from '../money-view.type';

/** The events whose consumers include the ledger (FINTAVA_WEBHOOK_EVENTS). */
export const LEDGER_WEBHOOK_EVENTS = [
  'account_funded',
  'virtual_wallet_payment',
  'customer_bank_transfer',
  'wallet_to_wallet_transfer_v2',
  'debit_transfer_reversal',
] as const;
export type LedgerWebhookEvent = (typeof LEDGER_WEBHOOK_EVENTS)[number];

/**
 * One party to a movement, as a delivery names it. The consumer decides
 * whether it is one of WAWU's wallets: a person's (FintavaWallet, by
 * account number or Fintava customerId) or WAWU's merchant wallet.
 */
export interface LedgerParty {
  /** Every account number the delivery gives for this party. */
  accountNumbers: string[];
  /** Fintava's customerId, when the delivery names one. */
  customerId: string | null;
  /** True for the party that is WAWU's merchant wallet by definition. */
  merchant: boolean;
  name: string | null;
  bankCode: string | null;
}

export interface LedgerWebhookMovement {
  kind: 'movement';
  event: LedgerWebhookEvent;
  /** null: the delivery reported no status we know. */
  status: TransferStatus | null;
  amountKobo: number;
  feeKobo: number;
  totalKobo: number;
  /** Every reference field the delivery carried (meaning unconfirmed, G-19). */
  references: string[];
  sessionId: string | null;
  from: LedgerParty | null;
  to: LedgerParty | null;
  category: TransactionCategory;
  narration: string | null;
  /**
   * True when nothing else can confirm the delivery: money in from a bank
   * or into a temporary account never appears in Fintava's history (debits
   * only, `sandbox/09-`, `10-`), so the signed delivery is the record.
   */
  trustAlone: boolean;
  /**
   * True when the docs leave open which named party is which
   * (`account_funded`): the consumer then takes as the receiver whichever
   * of the two is a WAWU wallet.
   */
  partiesMaySwap: boolean;
}

export interface LedgerWebhookReversal {
  kind: 'reversal';
  status: TransferStatus | null;
  /** References that may name the reversed debit. */
  references: string[];
  reversalReference: string | null;
  customerId: string | null;
  amountKobo: number | null;
  chargesKobo: number | null;
  totalKobo: number | null;
}

export interface LedgerWebhookUnreadable {
  kind: 'unreadable';
  why: string;
}

export type LedgerWebhookReading =
  LedgerWebhookMovement | LedgerWebhookReversal | LedgerWebhookUnreadable;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Obj, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function texts(o: Obj, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = text(o, k);
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Fintava's status words to the ledger's. Documented: `success`, `SUCCESS`,
 * `PAID` and the history's `PENDING`, `SUCCESS`, `CANCELLED`, `FAILURE`,
 * `ONGOING` (`sandbox/10-`). Anything else is null: not a status we know,
 * so the movement is confirmed with Fintava instead.
 */
export function ledgerStatusOf(
  raw: string | null | undefined,
): TransferStatus | null {
  const s = (raw ?? '').trim().toUpperCase();
  if (['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(s))
    return 'completed';
  if (['PENDING', 'ONGOING', 'PROCESSING'].includes(s)) return 'pending';
  if (['FAILURE', 'FAILED', 'CANCELLED', 'DECLINED'].includes(s))
    return 'failed';
  return null;
}

/** `"81450/100004"`: an account number and a bank code, as the docs print a destination. */
function destination(raw: string | null): {
  account: string | null;
  bank: string | null;
} {
  const m = raw ? /^\s*(\d{4,20})\s*\/\s*(\d{3,10})\s*$/.exec(raw) : null;
  return m ? { account: m[1], bank: m[2] } : { account: null, bank: null };
}

/** Required amount: a missing or unreadable one makes the delivery unreadable. */
function kobo(o: Obj, key: string): number {
  return fintavaAmountToKobo(o[key]);
}

function party(
  accountNumbers: (string | null)[],
  customerId: string | null,
  name: string | null,
  bankCode: string | null = null,
  merchant = false,
): LedgerParty {
  return {
    accountNumbers: [
      ...new Set(accountNumbers.filter((a): a is string => !!a)),
    ],
    customerId,
    merchant,
    name,
    bankCode,
  };
}

/**
 * Reads one stored delivery. `event` is MONEY-07's normalised name; `payload`
 * its parsed body. Never throws: what it cannot read is `unreadable`, and
 * the consumer marks the event `failed` with the reason.
 */
export function readLedgerWebhook(
  event: string,
  payload: unknown,
  eventReference: string,
): LedgerWebhookReading {
  const data = isObj(payload) && isObj(payload.data) ? payload.data : null;
  if (!data)
    return { kind: 'unreadable', why: 'the delivery has no data object' };
  try {
    switch (event) {
      case 'wallet_to_wallet_transfer_v2':
        return walletToWallet(data, eventReference);
      case 'account_funded':
        return accountFunded(data, eventReference);
      case 'customer_bank_transfer':
        return customerBankTransfer(data, eventReference);
      case 'virtual_wallet_payment':
        return virtualWalletPayment(data, eventReference);
      case 'debit_transfer_reversal':
        return reversal(data);
      default:
        return {
          kind: 'unreadable',
          why: `the ledger does not read ${event || 'an unnamed event'}`,
        };
    }
  } catch (e) {
    if (e instanceof FintavaAmountError) {
      return {
        kind: 'unreadable',
        why: 'an amount is not naira with at most 2 decimals',
      };
    }
    throw e;
  }
}

/**
 * `wallet_to_wallet_transfer_v2`: source to target, both Fintava wallets.
 * The docs give each side an `_accno` and a `_wallet` number, different in
 * the example and equal in every sandbox transfer response (`sandbox/13-`),
 * so both are matched. `source_customer_id` is the wallet's
 * tagpayCustomerId, not the customerId (`sandbox/13-`), so it is not used to
 * find a wallet. No status field is documented: the delivery reports the
 * balances after the move, but the movement is still confirmed with Fintava
 * when the ledger does not already hold it (ledger-consumer.service.ts).
 */
function walletToWallet(d: Obj, eventReference: string): LedgerWebhookReading {
  const amountKobo = kobo(d, 'amount');
  const feeKobo = fintavaAmountToKoboOrNull(d.transaction_fee) ?? 0;
  const totalKobo = fintavaAmountToKoboOrNull(d.total) ?? amountKobo + feeKobo;
  return {
    kind: 'movement',
    event: 'wallet_to_wallet_transfer_v2',
    status: ledgerStatusOf(text(d, 'status')),
    amountKobo,
    feeKobo,
    totalKobo,
    references: [
      ...texts(d, 'reference', 'customerReference', 'CustomerReference'),
      eventReference,
    ],
    sessionId: text(d, 'sessionID', 'sessionId'),
    from: party(
      [text(d, 'source_customer_accno'), text(d, 'source_customer_wallet')],
      null,
      text(d, 'source_customer_accname'),
    ),
    to: party(
      [text(d, 'target_customer_accno'), text(d, 'target_customer_wallet')],
      null,
      text(d, 'target_customer_accname'),
    ),
    category: 'transfer',
    narration: text(d, 'narration', 'description'),
    trustAlone: false,
    partiesMaySwap: false,
  };
}

/**
 * `account_funded`: money in from another bank. `userId` is read as the
 * receiving customer's Fintava customerId. Of the two account pairs, the one
 * that is a WAWU wallet is the receiver and the other is the sender
 * (Default (agent), owner may override: the docs name `beneficiary*` and
 * the plain `account*` fields without saying which side each is).
 */
function accountFunded(d: Obj, eventReference: string): LedgerWebhookReading {
  const amountKobo = kobo(d, 'amount');
  return {
    kind: 'movement',
    event: 'account_funded',
    // The event's name says the account was funded; a delivery without a
    // status is read as done.
    status: ledgerStatusOf(text(d, 'status')) ?? 'completed',
    amountKobo,
    feeKobo: 0,
    totalKobo: amountKobo,
    references: [...texts(d, 'reference', 'sessionID'), eventReference],
    sessionId: text(d, 'sessionID', 'sessionId'),
    from: party(
      [text(d, 'accountNumber')],
      null,
      text(d, 'accountName'),
      text(d, 'senderBankSortcode'),
    ),
    to: party(
      [text(d, 'beneficiaryAccountNumber')],
      text(d, 'userId', 'customerId'),
      text(d, 'beneficiaryAccountName'),
    ),
    category: 'top_up',
    narration: text(d, 'narration', 'description'),
    trustAlone: true,
    partiesMaySwap: true,
  };
}

/**
 * `customer_bank_transfer`: a customer's send to a bank. `charges` is what
 * Fintava took on top (`total` = amount + charges in the docs' example).
 */
function customerBankTransfer(
  d: Obj,
  eventReference: string,
): LedgerWebhookReading {
  const amountKobo = kobo(d, 'amount');
  const feeKobo = fintavaAmountToKoboOrNull(d.charges) ?? 0;
  const totalKobo = fintavaAmountToKoboOrNull(d.total) ?? amountKobo + feeKobo;
  const dest = destination(text(d, 'destination'));
  return {
    kind: 'movement',
    event: 'customer_bank_transfer',
    status: ledgerStatusOf(text(d, 'status')),
    amountKobo,
    feeKobo,
    totalKobo,
    references: [
      ...texts(
        d,
        'customerReference',
        'CustomerReference',
        'reference',
        'sessionID',
      ),
      eventReference,
    ],
    sessionId: text(d, 'sessionID', 'sessionId'),
    from: party(
      [text(d, 'senderAccountNumber')],
      text(d, 'customerId'),
      text(d, 'senderName'),
    ),
    to: party([dest.account], null, null, dest.bank),
    category: 'transfer',
    narration: text(d, 'narration', 'description'),
    trustAlone: false,
    partiesMaySwap: false,
  };
}

/** `virtual_wallet_payment`: a temporary account was paid; the money lands in WAWU's merchant wallet. */
function virtualWalletPayment(
  d: Obj,
  eventReference: string,
): LedgerWebhookReading {
  const amountKobo = kobo(d, 'amount');
  return {
    kind: 'movement',
    event: 'virtual_wallet_payment',
    status:
      ledgerStatusOf(text(d, 'paymentStatus')) ??
      ledgerStatusOf(text(d, 'status')),
    amountKobo,
    feeKobo: 0,
    totalKobo: amountKobo,
    references: [
      ...texts(d, 'merchantReference', 'reference', 'id'),
      eventReference,
    ],
    sessionId: null,
    from: party([], null, text(d, 'customerName')),
    to: party([], null, null, null, true),
    category: 'top_up',
    narration: text(d, 'description'),
    trustAlone: true,
    partiesMaySwap: false,
  };
}

/**
 * `debit_transfer_reversal`: a debit came back. `transactionReference` and
 * `customerReference` may name the reversed debit; `reversalRef` is the
 * reversal's own. `amount`, `charges` and `total` are kept as reported:
 * whether the charge is returned is not confirmed, so nothing is assumed.
 */
function reversal(d: Obj): LedgerWebhookReading {
  return {
    kind: 'reversal',
    status: ledgerStatusOf(text(d, 'status')),
    references: texts(
      d,
      'transactionReference',
      'customerReference',
      'CustomerReference',
      'reference',
    ),
    reversalReference: text(d, 'reversalRef'),
    customerId: text(d, 'customerId'),
    amountKobo: fintavaAmountToKoboOrNull(d.amount),
    chargesKobo: fintavaAmountToKoboOrNull(d.charges),
    totalKobo: fintavaAmountToKoboOrNull(d.total),
  };
}
