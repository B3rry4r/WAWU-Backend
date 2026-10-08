/**
 * Reading MONEY-07's stored Fintava deliveries as ledger movements (task
 * MONEY-10). Pure: no database, no Fintava call, so every rule here is
 * unit-tested on its own.
 *
 * Moved here from `src/money/ledger/ledger-webhook.ts` by MONEY-20: it is
 * Fintava's payload format, so it sits with the Fintava adapter, and the
 * ledger consumer reads it through the wallet provider
 * (`WalletProvider.deliveries`). The reading's types are the seam's own
 * (wallet-provider.interface.ts); a party at a Fintava wallet is
 * `provider_wallet` there.
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
import type { TransferStatus } from '../money/money-view.type';
import type {
  LedgerParty,
  LedgerPartyWhere,
  LedgerWebhookMovement,
  LedgerWebhookReading,
  LedgerWebhookReversal,
} from '../wallet-provider/wallet-provider.interface';
import {
  FintavaAmountError,
  fintavaAmountToKobo,
  fintavaAmountToKoboOrNull,
} from './fintava-amount';

/** The events whose consumers include the ledger (FINTAVA_WEBHOOK_EVENTS). */
export const LEDGER_WEBHOOK_EVENTS = [
  'account_funded',
  'virtual_wallet_payment',
  'customer_bank_transfer',
  'wallet_to_wallet_transfer_v2',
  'debit_transfer_reversal',
] as const;
export type LedgerWebhookEvent = (typeof LEDGER_WEBHOOK_EVENTS)[number];

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
  where: LedgerPartyWhere,
  accountNumbers: (string | null)[],
  o: {
    customerId?: string | null;
    name?: string | null;
    bankCode?: string | null;
  } = {},
): LedgerParty {
  return {
    where,
    accountNumbers: [
      ...new Set(accountNumbers.filter((a): a is string => !!a)),
    ],
    customerId: o.customerId ?? null,
    name: o.name ?? null,
    bankCode: o.bankCode ?? null,
  };
}

/** An amount the ledger refuses: never rounded, never clamped. */
class LedgerAmountError extends Error {}

/**
 * Every figure of a movement, checked before anything else happens (and so
 * before any Fintava call): the amount is above 0, a fee is not below 0, the
 * total is above 0, and amount plus fee stays a whole number a number holds
 * exactly. A delivery that fails is `unreadable` and its event `failed`.
 */
function checkedMovement(m: LedgerWebhookMovement): LedgerWebhookMovement {
  if (m.amountKobo <= 0)
    throw new LedgerAmountError('the amount is not above 0');
  if (m.feeKobo < 0) throw new LedgerAmountError('the fee is below 0');
  if (m.totalKobo <= 0) throw new LedgerAmountError('the total is not above 0');
  if (!Number.isSafeInteger(m.amountKobo + m.feeKobo)) {
    throw new LedgerAmountError('amount and fee pass 2^53 kobo');
  }
  return m;
}

function checkedReversal(r: LedgerWebhookReversal): LedgerWebhookReversal {
  if (r.amountKobo !== null && r.amountKobo <= 0) {
    throw new LedgerAmountError('the reversed amount is not above 0');
  }
  if (r.chargesKobo !== null && r.chargesKobo < 0) {
    throw new LedgerAmountError('the reversed charges are below 0');
  }
  if (r.totalKobo !== null && r.totalKobo <= 0) {
    throw new LedgerAmountError('the reversed total is not above 0');
  }
  return r;
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
        return checkedMovement(walletToWallet(data, eventReference));
      case 'account_funded':
        return checkedMovement(accountFunded(data, eventReference));
      case 'customer_bank_transfer':
        return checkedMovement(customerBankTransfer(data, eventReference));
      case 'virtual_wallet_payment':
        return checkedMovement(virtualWalletPayment(data, eventReference));
      case 'debit_transfer_reversal':
        return checkedReversal(reversal(data));
      default:
        return {
          kind: 'unreadable',
          why: `the ledger does not read ${event || 'an unnamed event'}`,
        };
    }
  } catch (e) {
    if (e instanceof LedgerAmountError) {
      return { kind: 'unreadable', why: e.message };
    }
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
function walletToWallet(d: Obj, eventReference: string): LedgerWebhookMovement {
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
      'provider_wallet',
      [text(d, 'source_customer_accno'), text(d, 'source_customer_wallet')],
      { name: text(d, 'source_customer_accname') },
    ),
    to: party(
      'provider_wallet',
      [text(d, 'target_customer_accno'), text(d, 'target_customer_wallet')],
      { name: text(d, 'target_customer_accname') },
    ),
    category: 'transfer',
    narration: text(d, 'narration', 'description'),
    trustAlone: false,
  };
}

/**
 * `account_funded`: money in from another bank. Default (agent), owner may
 * override, until a real delivery shows the fields: `userId` is the
 * receiving customer's Fintava customerId, and the receiver is found by it;
 * only a delivery without one falls back to `beneficiaryAccountNumber`. The
 * plain `accountName` and `accountNumber`, beside `senderBankSortcode`, are
 * the sender at the other bank: a `bank_account`, so it is never taken for a
 * WAWU wallet by its number (MONEY-10 verifier, defect 1).
 */
function accountFunded(d: Obj, eventReference: string): LedgerWebhookMovement {
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
    from: party('bank_account', [text(d, 'accountNumber')], {
      name: text(d, 'accountName'),
      bankCode: text(d, 'senderBankSortcode'),
    }),
    to: party('provider_wallet', [text(d, 'beneficiaryAccountNumber')], {
      customerId: text(d, 'userId', 'customerId'),
      name: text(d, 'beneficiaryAccountName'),
    }),
    category: 'top_up',
    narration: text(d, 'narration', 'description'),
    trustAlone: true,
  };
}

/**
 * `customer_bank_transfer`: a customer's send to a bank. `charges` is what
 * Fintava took on top (`total` = amount + charges in the docs' example).
 */
function customerBankTransfer(
  d: Obj,
  eventReference: string,
): LedgerWebhookMovement {
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
    from: party('provider_wallet', [text(d, 'senderAccountNumber')], {
      customerId: text(d, 'customerId'),
      name: text(d, 'senderName'),
    }),
    // The destination is at a bank, named by its code: a WAWU wallet only
    // when that bank is Fintava's own (the consumer checks).
    to: party('bank_account', [dest.account], { bankCode: dest.bank }),
    category: 'transfer',
    narration: text(d, 'narration', 'description'),
    trustAlone: false,
  };
}

/** `virtual_wallet_payment`: a temporary account was paid; the money lands in WAWU's merchant wallet. */
function virtualWalletPayment(
  d: Obj,
  eventReference: string,
): LedgerWebhookMovement {
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
    from: party('bank_account', [], { name: text(d, 'customerName') }),
    to: party('merchant', []),
    category: 'top_up',
    narration: text(d, 'description'),
    trustAlone: true,
  };
}

/**
 * `debit_transfer_reversal`: a debit came back. `transactionReference` and
 * `customerReference` may name the reversed debit; `reversalRef` is the
 * reversal's own. `amount`, `charges` and `total` are kept as reported:
 * whether the charge is returned is not confirmed, so nothing is assumed.
 */
function reversal(d: Obj): LedgerWebhookReversal {
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
