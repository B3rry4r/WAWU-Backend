import { isNuvionId } from './accounts';

/**
 * How Nuvion's answers for reconciliation are read (task NUV-08): statement
 * lines, webhook subscriptions and fee simulations. Pure: no call, no clock,
 * no database. Every figure is whole kobo or the line is refused; nothing is
 * rounded or guessed.
 *
 * WHAT THIS FILE ASSUMES, in one place. The lead's saved copy of Nuvion's
 * docs (`nuvion/docs/api-reference__accounts.md`, `api-reference__webhooks.md`)
 * was not on the machine this was built on, so the shapes below come from
 * the task text and from the transfer object Nuvion's other pages show
 * (`id`, `amount`, `applicable_fee`, `status`, `type`, `payment_type`,
 * `unique_reference`, `narration`, `created` in Unix milliseconds):
 * - a statement is a cursor list (`data.data`, `data.meta.pagination`) of
 *   lines, each carrying its transfer's id as `transfer_id` (else `id`), a
 *   `type` of `inflow` or `outflow`, the amount, the fee as `applicable_fee`
 *   (else `fee`) and the running balance as `balance_after` (else
 *   `running_balance`);
 * - a webhook subscription carries `id`, `url`, `enabled_events` and either
 *   `expires_at` (Unix milliseconds or ISO text) or `created` with
 *   `expires_in` (seconds);
 * - a fee simulation answers the fee as `applicable_fee` (else `fee`).
 * Each assumption is read here and nowhere else, so the first sandbox month
 * (the task's (key) check) corrects one function if Nuvion's page differs.
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
  /** The transfer the line is about: what a webhook for it would name. */
  transferId: string;
  entityId: string | null;
  accountId: string | null;
  /** Money in or money out on this account. */
  direction: 'in' | 'out';
  amountKobo: number;
  /** The fee the line states; null when it states none (not a charge of 0). */
  feeKobo: number | null;
  /** The account's balance right after this line; null when not stated. */
  balanceAfterKobo: number | null;
  /** Nuvion's word: pending, processing, successful, failed or reversed. */
  status: string;
  /** ISO 4217, upper case. */
  currency: string;
  paymentType: string | null;
  uniqueReference: string | null;
  narration: string | null;
  createdAt: Date | null;
}

/** Reads one statement line. Never throws. */
export function readStatementLine(
  raw: unknown,
): { ok: true; line: NuvionStatementLine } | { ok: false; why: string } {
  if (!isRecord(raw)) return { ok: false, why: 'a line is not an object' };
  const fromTransfer = text(raw, 'transfer_id');
  const idOf = fromTransfer ?? text(raw, 'id');
  if (!isNuvionId(idOf)) {
    return {
      ok: false,
      why: 'a line names no transfer in the form Nuvion uses',
    };
  }
  const type = text(raw, 'type')?.toLowerCase() ?? null;
  const direction =
    type === 'inflow' || type === 'credit'
      ? 'in'
      : type === 'outflow' || type === 'debit'
        ? 'out'
        : null;
  if (direction === null) {
    return { ok: false, why: 'a line is neither money in nor money out' };
  }
  const amount = whole(raw.amount);
  if (amount === null || amount <= 0) {
    return { ok: false, why: 'a line amount is not a positive whole number' };
  }
  const feeRaw = raw.applicable_fee ?? raw.fee;
  let fee: number | null = null;
  if (feeRaw !== undefined && feeRaw !== null) {
    fee = whole(feeRaw);
    if (fee === null || fee < 0) {
      return {
        ok: false,
        why: 'a line fee is not a whole number at or above 0',
      };
    }
  }
  const balanceRaw = raw.balance_after ?? raw.running_balance;
  let balance: number | null = null;
  if (balanceRaw !== undefined && balanceRaw !== null) {
    balance = whole(balanceRaw);
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
  const created = raw.created;
  const createdAt =
    typeof created === 'number' && Number.isSafeInteger(created) && created > 0
      ? new Date(created)
      : null;
  return {
    ok: true,
    line: {
      transferId: idOf,
      entityId: text(raw, 'entity_id'),
      accountId: text(raw, 'account_id'),
      direction,
      amountKobo: amount,
      feeKobo: fee,
      balanceAfterKobo: balance,
      status,
      currency,
      paymentType: text(raw, 'payment_type')?.toLowerCase() ?? null,
      uniqueReference: text(raw, 'unique_reference'),
      narration: text(raw, 'narration'),
      createdAt:
        createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook subscriptions
// ---------------------------------------------------------------------------

/** One webhook subscription at Nuvion, the fields renewal needs. */
export interface NuvionWebhookSubscription {
  id: string;
  url: string;
  events: string[];
  /** When Nuvion stops sending to it; null when the record does not say. */
  expiresAt: Date | null;
  /** The period it was given, in seconds, when the record says. */
  expiresInSeconds: number | null;
  active: boolean;
}

function dateOf(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Reads one subscription. Null when it carries no id or no address. */
export function readWebhookSubscription(
  raw: unknown,
): NuvionWebhookSubscription | null {
  const o = isRecord(raw) && isRecord(raw.webhook) ? raw.webhook : raw;
  if (!isRecord(o)) return null;
  const id = text(o, 'id');
  const url = text(o, 'url');
  if (!isNuvionId(id) || !url) return null;
  const inSeconds = whole(o.expires_in);
  let expiresAt = dateOf(o.expires_at);
  if (expiresAt === null && inSeconds !== null && inSeconds > 0) {
    const from = dateOf(o.updated) ?? dateOf(o.created);
    if (from) expiresAt = new Date(from.getTime() + inSeconds * 1000);
  }
  const events = Array.isArray(o.enabled_events)
    ? o.enabled_events.filter((e): e is string => typeof e === 'string')
    : [];
  const status = text(o, 'status')?.toLowerCase() ?? null;
  return {
    id,
    url,
    events,
    expiresAt,
    expiresInSeconds: inSeconds !== null && inSeconds > 0 ? inSeconds : null,
    active: status === null ? true : status === 'active',
  };
}

// ---------------------------------------------------------------------------
// Fee simulations
// ---------------------------------------------------------------------------

/** The fee a simulation answers, in kobo; null when the answer states none. */
export function readFeeSimulation(raw: unknown): number | null {
  const o = isRecord(raw) && isRecord(raw.simulation) ? raw.simulation : raw;
  if (!isRecord(o)) return null;
  const fee = whole(o.applicable_fee ?? o.fee);
  return fee !== null && fee >= 0 ? fee : null;
}
