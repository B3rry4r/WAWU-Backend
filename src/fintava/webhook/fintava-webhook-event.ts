import { createHash } from 'node:crypto';

/**
 * Reading a Fintava webhook delivery (task MONEY-07).
 *
 * Everything here comes from the mobile repo's `docs/fintava/naira-api.md`
 * ("Webhooks") and the saved pages `reference/webhook-events.md` and
 * `reference/verifying-events.md`. No real delivery has been received yet
 * (`sandbox/23-webhooks.md`): the first ones are recorded once OPS-10
 * registers the production URL, and this file is corrected to match them.
 *
 * Fintava sends no event id and no timestamp. A delivery is identified by
 * three things, and the store's unique key is exactly these:
 * - the event name;
 * - the transaction reference it carries (which field, per event, below);
 * - the status it reports, so a later delivery for the same transaction
 *   with a new status (PENDING, then SUCCESS) is a new row, while a retry
 *   of the same delivery is not.
 */

/**
 * The events Fintava documents, what each is keyed on, and the task that
 * consumes it. Every one is stored `pending` for that task: MONEY-07 only
 * records and acknowledges, it never moves money or touches a balance.
 *
 * `references` is the order in which `data` fields are tried for the key.
 * Default (agent), owner may override, until a real delivery shows the
 * fields:
 * - `account_funded`: `reference` (the inbound transfer's), else the NIBSS
 *   `sessionID`. No reference of ours exists for money sent in from a bank.
 * - `virtual_wallet_payment`: `merchantReference` (ours, set when the
 *   virtual wallet is generated), else `reference`, else the wallet `id`.
 * - `customer_bank_transfer` and `wallet_to_wallet_transfer_v2`: the
 *   `customerReference` field first, then `reference`. A transfer RESPONSE
 *   swaps these names (its `customerReference` is Fintava's findable
 *   reference and its `reference` the unfindable `tagapayTransRef`,
 *   `sandbox/11-`); the documented wallet-to-wallet delivery carries only
 *   `reference`. Either way both are unique per transaction, which is all
 *   the key needs, and both are stored as sent (`dataReference`,
 *   `dataCustomerReference`) so the consumer matches whichever it holds.
 * - `debit_transfer_reversal`: the reversal's own `reversalRef`, else the
 *   reversed debit's `transactionReference`, else `customerReference`.
 * - Card events: payloads unpublished, so the generic order.
 */
const GENERIC_REFERENCES = [
  'reference',
  'transactionReference',
  'customerReference',
  'CustomerReference',
  'merchantReference',
  'sessionID',
  'id',
] as const;

export const FINTAVA_WEBHOOK_EVENTS: Record<
  string,
  { consumers: readonly string[]; references: readonly string[] }
> = {
  /** Money in from another bank to a customer's account number (W15). */
  account_funded: {
    consumers: ['MONEY-10', 'WALLET-10'],
    references: ['reference', 'sessionID'],
  },
  /** A temporary account was paid; not used at launch. */
  virtual_wallet_payment: {
    consumers: ['MONEY-10'],
    references: ['merchantReference', 'reference', 'id'],
  },
  /** A customer's send to a bank settled. */
  customer_bank_transfer: {
    consumers: ['MONEY-10', 'MONEY-08'],
    references: [
      'customerReference',
      'CustomerReference',
      'reference',
      'sessionID',
    ],
  },
  /** A wallet sent to a wallet: the only record of money received from one. */
  wallet_to_wallet_transfer_v2: {
    consumers: ['MONEY-10'],
    references: ['customerReference', 'CustomerReference', 'reference'],
  },
  /** A debit came back: how a failed bank send shows up. */
  debit_transfer_reversal: {
    consumers: ['MONEY-10', 'MONEY-08'],
    references: [
      'reversalRef',
      'transactionReference',
      'customerReference',
      'CustomerReference',
      'reference',
    ],
  },
  /** Cards are after launch; payload unpublished. */
  card_payment: { consumers: ['WALLET-22'], references: GENERIC_REFERENCES },
  dynamic_card_payment: {
    consumers: ['WALLET-22'],
    references: GENERIC_REFERENCES,
  },
};

/** Longest reference kept as a key; anything longer is not a reference. */
const MAX_REFERENCE = 200;
const MAX_EVENT = 64;
const MAX_STATUS = 32;

/** What one delivery is, ready to store. */
export interface FintavaWebhookDelivery {
  /** Lower case; '' when the body named no event. */
  event: string;
  eventRaw: string | null;
  /** True when `event` is one Fintava documents. */
  known: boolean;
  reference: string;
  referenceField: string;
  /** Upper case; '' when the delivery reported none. */
  fintavaStatus: string;
  dataReference: string | null;
  dataCustomerReference: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Postgres text and json cannot hold a NUL (`\u0000`), and a delivery the
 * database refuses is retried for 72 hours and then lost. Every string we
 * store is passed through this: each NUL becomes U+FFFD, the same way every
 * time, so a replay still produces the same key. The raw body is stored
 * as bytes and keeps the original.
 */
export function withoutNul(s: string): string {
  return s.includes('\u0000') ? s.split('\u0000').join('\uFFFD') : s;
}

/** The parsed body with withoutNul applied to every key and string. */
export function jsonWithoutNul(value: unknown): unknown {
  if (typeof value === 'string') return withoutNul(value);
  if (Array.isArray(value)) return value.map(jsonWithoutNul);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[withoutNul(k)] = jsonWithoutNul(v);
    }
    return out;
  }
  return value;
}

/** A non-empty string or a finite number, as trimmed text; else null. */
function text(v: unknown, max: number): string | null {
  let s: string;
  if (typeof v === 'string') s = withoutNul(v).trim();
  else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else return null;
  return s.length > 0 && s.length <= max ? s : null;
}

/**
 * The event name. The events page says `event`; the verification sample
 * switches on `type` (`reference/verifying-events.md`), so both are read,
 * `event` first, and the field name in any case (`Event`, `TYPE`). Only the
 * top level is read: `data.type` is something else (`"CREDIT"` on a
 * reversal).
 */
function readEventName(body: Record<string, unknown>): string | null {
  for (const want of ['event', 'type']) {
    for (const [key, value] of Object.entries(body)) {
      if (key.toLowerCase() !== want) continue;
      const name = text(value, 128);
      if (name) return name;
    }
  }
  return null;
}

/** sha256 of the raw body, for a delivery that carries no usable reference. */
export function bodyDigest(rawBody: Buffer): string {
  return `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}

/**
 * Reads a signed delivery. Never throws: whatever Fintava sent is stored,
 * and anything we cannot place is stored as unrecognised rather than
 * refused (a refusal would only make Fintava retry it for 72 hours).
 */
export function readFintavaWebhook(
  body: unknown,
  rawBody: Buffer,
): FintavaWebhookDelivery {
  const top = isRecord(body) ? body : {};
  const data = isRecord(top.data) ? top.data : {};

  const eventRaw = readEventName(top);
  const normalised = eventRaw?.toLowerCase() ?? '';
  const event =
    normalised.length <= MAX_EVENT && /^[a-z0-9_.-]+$/.test(normalised)
      ? normalised
      : '';
  const spec = Object.prototype.hasOwnProperty.call(
    FINTAVA_WEBHOOK_EVENTS,
    event,
  )
    ? FINTAVA_WEBHOOK_EVENTS[event]
    : undefined;

  let reference: string | null = null;
  let referenceField = 'body.sha256';
  for (const field of spec?.references ?? GENERIC_REFERENCES) {
    const value = text(data[field], MAX_REFERENCE);
    if (value) {
      reference = value;
      referenceField = `data.${field}`;
      break;
    }
  }

  const status =
    text(data.status, MAX_STATUS) ?? text(data.paymentStatus, MAX_STATUS);

  return {
    event,
    eventRaw,
    known: spec !== undefined,
    reference: reference ?? bodyDigest(rawBody),
    referenceField,
    fintavaStatus: status?.toUpperCase() ?? '',
    dataReference: text(data.reference, MAX_REFERENCE),
    dataCustomerReference:
      text(data.customerReference, MAX_REFERENCE) ??
      text(data.CustomerReference, MAX_REFERENCE),
  };
}
