import type { TransferStatus } from '../../money/money-view.type';
import { nuvionTransferStatus } from '../nuvion-ledger-delivery';
import { isNuvionId } from './accounts';

/**
 * How Nuvion's answers for reconciliation are read (task NUV-08): statement
 * lines and webhook subscriptions. Pure: no call, no clock, no database.
 * Every figure is whole kobo or the line is refused; nothing is rounded or
 * guessed.
 *
 * The shapes are Nuvion's public docs, nothing else (round 2, after the
 * verifier read them; `docs.nuvion.co`, saved as `api-reference__*.md`):
 * - a statement line (`api-reference__accounts.md`, "Get account statements",
 *   the `transactions` fields and the example body) is `transaction_id`,
 *   `date` (ISO 8601 text), `type` (`credit` or `debit`), `amount` (before
 *   the fee), `fee`, `running_balance`, `reference`, `status` (`completed`
 *   or `pending`) and `currency`. It names no entity, account, payment type
 *   or narration. Whether `transaction_id` is the transfer's id (what
 *   `GET /transfers/{id}` takes) is not said in the docs; the first sandbox
 *   month (the task's (key) check) confirms it.
 * - a webhook subscription (`api-reference__webhooks.md`, "The Webhook
 *   object") is `id`, `url`, `expires_in` (seconds, given at creation),
 *   `enabled_events` (an object of groups), `status` (`active` or
 *   `inactive`). The docs show no expiry date and no call that extends one:
 *   an expired subscription goes `inactive` (`expires_in`, :27 to :28), and
 *   the only thing to do about it is to report it.
 * Each shape is read here and nowhere else.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function whole(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Statement lines
// ---------------------------------------------------------------------------

/** One line of an account's statement, as the reconciliation needs it. */
export interface NuvionStatementLine {
  /** `transaction_id`: the transfer the line is about, what a webhook would name. */
  transferId: string;
  /** Money in (`credit`) or money out (`debit`) on this account. */
  direction: 'in' | 'out';
  amountKobo: number;
  /** The fee the line states; null when it states none (not a charge of 0). */
  feeKobo: number | null;
  /** The account's balance right after this line; null when not stated. */
  balanceAfterKobo: number | null;
  /** Nuvion's word for a line: `completed` or `pending`. */
  status: string;
  /** The line's status as a ledger status; null when not one we know. */
  outcome: TransferStatus | null;
  /** ISO 4217, upper case. */
  currency: string;
  /** `reference`: the idempotency or tracking reference, as Nuvion states it. */
  reference: string | null;
  /** `date`; null when the line carries none that can be read. */
  createdAt: Date | null;
}

/** A statement line's status as a ledger status: `completed` and `pending`. */
export function statementOutcome(status: string): TransferStatus | null {
  const s = status.toLowerCase();
  return s === 'completed' ? 'completed' : nuvionTransferStatus(s);
}

/** Reads one statement line. Never throws. */
export function readStatementLine(
  raw: unknown,
): { ok: true; line: NuvionStatementLine } | { ok: false; why: string } {
  if (!isRecord(raw)) return { ok: false, why: 'a line is not an object' };
  const id = text(raw, 'transaction_id');
  if (!isNuvionId(id)) {
    return {
      ok: false,
      why: 'a line names no transaction in the form Nuvion uses',
    };
  }
  const type = text(raw, 'type')?.toLowerCase() ?? null;
  const direction = type === 'credit' ? 'in' : type === 'debit' ? 'out' : null;
  if (direction === null) {
    return { ok: false, why: 'a line is neither money in nor money out' };
  }
  const amount = whole(raw.amount);
  if (amount === null || amount <= 0) {
    return { ok: false, why: 'a line amount is not a positive whole number' };
  }
  let fee: number | null = null;
  if (raw.fee !== undefined && raw.fee !== null) {
    fee = whole(raw.fee);
    if (fee === null || fee < 0) {
      return {
        ok: false,
        why: 'a line fee is not a whole number at or above 0',
      };
    }
  }
  let balance: number | null = null;
  if (raw.running_balance !== undefined && raw.running_balance !== null) {
    balance = whole(raw.running_balance);
    if (balance === null) {
      return { ok: false, why: 'a line balance is not a whole number' };
    }
  }
  const currency = text(raw, 'currency')?.toUpperCase() ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, why: 'a line names no currency' };
  }
  const status = text(raw, 'status')?.toLowerCase() ?? null;
  if (!status) return { ok: false, why: 'a line has no status' };
  const outcome = statementOutcome(status);
  if (outcome === null) return { ok: false, why: 'a line status is unknown' };
  const date = text(raw, 'date');
  const createdAt = date === null ? null : new Date(date);
  return {
    ok: true,
    line: {
      transferId: id,
      direction,
      amountKobo: amount,
      feeKobo: fee,
      balanceAfterKobo: balance,
      status,
      outcome,
      currency,
      reference: text(raw, 'reference'),
      createdAt:
        createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook subscriptions
// ---------------------------------------------------------------------------

/** One webhook subscription at Nuvion, the fields the check needs. */
export interface NuvionWebhookSubscription {
  id: string;
  url: string;
  /** Nuvion's word: `active` or `inactive`; null when the record has none. */
  status: string | null;
  /** True only for `active`: a subscription of any other state is not delivering. */
  active: boolean;
  /** The groups switched on, as `inflows.completed`; `all` when all are. */
  events: string[];
  /** The period it was given at creation, in seconds. */
  expiresInSeconds: number | null;
}

/** The events an `enabled_events` object switches on (webhooks.md, "enabled_events"). */
function enabledEvents(v: unknown): string[] {
  if (!isRecord(v)) return [];
  if (v.all === true) return ['all'];
  const out: string[] = [];
  for (const [group, flags] of Object.entries(v)) {
    if (!isRecord(flags)) continue;
    for (const [name, on] of Object.entries(flags)) {
      if (on === true) out.push(`${group}.${name}`);
    }
  }
  return out;
}

/** Reads one subscription. Null when it carries no id or no address. */
export function readWebhookSubscription(
  raw: unknown,
): NuvionWebhookSubscription | null {
  if (!isRecord(raw)) return null;
  const id = text(raw, 'id');
  const url = text(raw, 'url');
  if (!isNuvionId(id) || !url) return null;
  const inSeconds = whole(raw.expires_in);
  const status = text(raw, 'status')?.toLowerCase() ?? null;
  return {
    id,
    url,
    status,
    active: status === 'active',
    events: enabledEvents(raw.enabled_events),
    expiresInSeconds: inSeconds !== null && inSeconds > 0 ? inSeconds : null,
  };
}
