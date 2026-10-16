import type { TransferStatus } from '../money/money-view.type';
import type {
  LedgerWebhookMovement,
  LedgerWebhookReading,
  ProviderDeliveries,
} from '../wallet-provider/wallet-provider.interface';
import { isNuvionId, NUVION_NAIRA } from './areas/accounts';

/**
 * Nuvion's transfers read for the ledger (task NUV-04): one transfer object
 * (an `inflows.completed` delivery's `data`, or `GET /transfers/{id}`'s
 * answer, which Nuvion says to read before treating money as received)
 * turned into the provider-neutral reading the ledger takes
 * (`LedgerWebhookMovement`, wallet-provider.interface.ts): kobo, the
 * `applicable_fee`, the sender, the narration, Nuvion's id and its
 * `unique_reference`. Pure: no call, no clock, no database.
 *
 * Nuvion's amounts are already whole numbers of the smallest unit
 * (api-reference__transfers.md: `10000` = 100.00), so a naira amount is
 * kobo as it is: nothing is multiplied, divided or rounded. Anything that
 * is not a positive whole number, a fee that is not a whole number at or
 * above zero, or a sum past what a number holds exactly, is unreadable:
 * never rounded into a figure.
 *
 * The references a row is known by are Nuvion's transfer id and its
 * `unique_reference`, never the delivery's event id: NUV-08, finding a
 * transfer whose delivery never came, reads the same transfer through
 * the same function and lands on the same row (the ledger's reference
 * key), so the money is recorded once however it was seen.
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

/** One Nuvion transfer, field by field, as the ledger needs it. */
export interface NuvionTransferReading {
  /** Nuvion's transfer id (an inflow's `data.id`). */
  id: string;
  entityId: string | null;
  accountId: string | null;
  /** Kobo for naira: Nuvion's smallest unit. */
  amountKobo: number;
  /** `applicable_fee`, in the same unit; 0 when Nuvion sent none. */
  feeKobo: number;
  /** ISO 4217, upper case. */
  currency: string;
  /** Nuvion's word: pending, processing, successful, failed or reversed. */
  status: string;
  /** `inflow` or `outflow`. */
  type: string | null;
  /** `bank-transfer`, `book-transfer` and so on. */
  paymentType: string | null;
  /** The idempotency key the transfer was made with. */
  uniqueReference: string | null;
  /** The sending (inflow) or receiving (outflow) counterparty's id. */
  counterpartyId: string | null;
  narration: string | null;
  /** `created`, Unix milliseconds, as a date; null when unreadable. */
  createdAt: Date | null;
}

/** Nuvion's transfer status as a ledger status; null when not one we know. */
export function nuvionTransferStatus(status: string): TransferStatus | null {
  switch (status.toLowerCase()) {
    case 'successful':
      return 'completed';
    case 'pending':
    case 'processing':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return null;
  }
}

/**
 * Reads one transfer object. `raw` may be the transfer itself or a wrapper
 * holding it as `transfer` (an answer's shape is not assumed beyond the
 * docs' example, which is the object itself). Never throws.
 */
export function readNuvionTransfer(
  raw: unknown,
): { ok: true; transfer: NuvionTransferReading } | { ok: false; why: string } {
  const o = isRecord(raw) && isRecord(raw.transfer) ? raw.transfer : raw;
  if (!isRecord(o)) return { ok: false, why: 'the transfer is not an object' };
  const id = text(o, 'id');
  if (!isNuvionId(id)) {
    return { ok: false, why: 'the transfer has no id in the form Nuvion uses' };
  }
  const amount = o.amount;
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    return {
      ok: false,
      why: 'the amount is not a positive whole number of kobo',
    };
  }
  const feeRaw = o.applicable_fee;
  let fee = 0;
  if (feeRaw !== undefined && feeRaw !== null) {
    if (
      typeof feeRaw !== 'number' ||
      !Number.isSafeInteger(feeRaw) ||
      feeRaw < 0
    ) {
      return {
        ok: false,
        why: 'the fee is not a whole number of kobo at or above 0',
      };
    }
    fee = feeRaw;
  }
  if (!Number.isSafeInteger(amount + fee)) {
    return {
      ok: false,
      why: 'the amount and fee are beyond what a number holds exactly',
    };
  }
  const currency = text(o, 'currency')?.toUpperCase() ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, why: 'the transfer names no currency' };
  }
  const status = text(o, 'status')?.toLowerCase() ?? null;
  if (!status) return { ok: false, why: 'the transfer has no status' };
  const created = o.created;
  const createdAt =
    typeof created === 'number' && Number.isSafeInteger(created) && created > 0
      ? new Date(created)
      : null;
  return {
    ok: true,
    transfer: {
      id,
      entityId: text(o, 'entity_id'),
      accountId: text(o, 'account_id'),
      amountKobo: amount,
      feeKobo: fee,
      currency,
      status,
      type: text(o, 'type')?.toLowerCase() ?? null,
      paymentType: text(o, 'payment_type')?.toLowerCase() ?? null,
      uniqueReference: text(o, 'unique_reference'),
      counterpartyId: text(o, 'counterparty_id'),
      narration: text(o, 'narration'),
      createdAt:
        createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
    },
  };
}

/**
 * Why a transfer, read back from Nuvion, is not money in by bank transfer
 * to this naira account, or null when it is. Compared field by field with
 * what the delivery and our own records say: another account or entity, a
 * currency other than naira, not an inflow, another rail (a book transfer
 * is NUV-05's), or figures that differ from the delivery's. Its status is
 * judged by the caller.
 */
export function nuvionInflowProblem(
  t: NuvionTransferReading,
  expect: {
    id: string;
    entityId: string;
    accountId: string;
    /** The delivery's own figures, when it carried them. */
    delivered?: NuvionTransferReading | null;
  },
): string | null {
  if (t.id !== expect.id) return 'Nuvion answered another transfer';
  if (t.accountId !== expect.accountId) {
    return 'the transfer is into another account';
  }
  if (t.entityId !== null && t.entityId !== expect.entityId) {
    return 'the transfer is for another entity';
  }
  if (t.currency !== NUVION_NAIRA) {
    return `the transfer is in ${t.currency}, not naira`;
  }
  if (t.type !== null && t.type !== 'inflow')
    return 'the transfer is not money in';
  const d = expect.delivered;
  if (d) {
    if (d.amountKobo !== t.amountKobo || d.feeKobo !== t.feeKobo) {
      return `Nuvion's record says ${t.amountKobo} kobo (fee ${t.feeKobo}), the delivery ${d.amountKobo} (fee ${d.feeKobo})`;
    }
    if (d.currency !== t.currency) {
      return `Nuvion's record is in ${t.currency}, the delivery in ${d.currency}`;
    }
    if (d.accountId !== null && d.accountId !== t.accountId) {
      return 'the delivery names another account than the one Nuvion records';
    }
  }
  return null;
}

/**
 * One inflow as the ledger's neutral reading: money in on the receiving
 * wallet (`to`, found by the entity's id, Nuvion's customer), from a sender
 * at a bank whose name and number Nuvion's inflow does not give (only its
 * `counterparty_id`). `amountKobo` is what Nuvion credited the account
 * with; `feeKobo` is Nuvion's `applicable_fee` as it reports it; the total
 * on a money-in row is the amount. Trusted alone once it has been read back
 * from Nuvion (the caller does that first).
 */
export function nuvionInflowMovement(
  t: NuvionTransferReading,
): LedgerWebhookMovement {
  return {
    kind: 'movement',
    event: 'inflows.completed',
    status: nuvionTransferStatus(t.status),
    amountKobo: t.amountKobo,
    feeKobo: t.feeKobo,
    totalKobo: t.amountKobo,
    references: [t.id, ...(t.uniqueReference ? [t.uniqueReference] : [])],
    sessionId: null,
    from: {
      where: 'bank_account',
      accountNumbers: [],
      customerId: null,
      name: null,
      bankCode: null,
    },
    to: {
      where: 'provider_wallet',
      accountNumbers: [],
      customerId: t.entityId,
      name: null,
      bankCode: null,
    },
    category: 'top_up',
    narration: t.narration,
    trustAlone: true,
  };
}

/** The events whose deliveries are money in (NUV-04). */
export const NUVION_INFLOW_EVENTS = [
  'inflows.completed',
  'inflows.failed',
] as const;

/**
 * Nuvion's stored deliveries as the seam's `ProviderDeliveries` reader: an
 * `inflows.completed` delivery's `data` becomes its movement, anything else
 * is unreadable (an `inflows.failed` credits nothing). Not wired into the
 * generic ledger consumer, which reads Fintava's delivery table only
 * (NUV-01): Nuvion's inflows reach the ledger through NUV-04's handler,
 * after the transfer is read back from Nuvion. Exported for NUV-08, whose
 * reconciliation area owns the adapter's `deliveries`.
 */
export const NUVION_LEDGER_DELIVERIES: ProviderDeliveries = {
  ledgerEvents: ['inflows.completed'],
  read(event: string, payload: unknown): LedgerWebhookReading {
    if (event !== 'inflows.completed') {
      return { kind: 'unreadable', why: `${event} is not money in` };
    }
    const data =
      isRecord(payload) && 'data' in payload ? payload.data : payload;
    const r = readNuvionTransfer(data);
    if (!r.ok) return { kind: 'unreadable', why: r.why };
    return nuvionInflowMovement(r.transfer);
  },
};
