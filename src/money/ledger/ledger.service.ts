import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { TransferStatus } from '../money-view.type';
import type {
  LedgerDirection,
  LedgerMovementInput,
  LedgerRecordResult,
  LedgerReferenceKind,
  LedgerReferences,
  LedgerReversalInput,
  LedgerReversalResult,
} from './ledger.interface';

type Db = PrismaService | Prisma.TransactionClient;

/** Longest reference kept; MONEY-07 keys on at most 200 characters too. */
const MAX_REFERENCE = 200;

/** When two kinds name the same text, the more specific one is kept. */
const KIND_ORDER: readonly LedgerReferenceKind[] = [
  'ours',
  'fintava',
  'tagapay',
  'transaction_id',
  'session',
  'delivery',
];

/**
 * Which statuses a row may move to from where it is. A movement only moves
 * forward: a reversed row never goes back to completed because a late
 * delivery said SUCCESS, and a sighting that says `pending` changes nothing.
 *
 * A completed row never becomes `failed` (MONEY-08, the MONEY-10 verifier's
 * U-1): money that left stays shown as gone until Fintava's reversal says it
 * came back (`reversed`). A later report of FAILED for it is a disagreement
 * with Fintava, recorded on `discrepancy` (LedgerService.merge) for MONEY-16,
 * never applied.
 */
const MAY_BECOME: Record<TransferStatus, readonly TransferStatus[]> = {
  pending: [],
  completed: ['pending'],
  failed: ['pending'],
  reversed: ['pending', 'completed', 'failed'],
};

export function ledgerStatusMayMove(
  from: TransferStatus,
  to: TransferStatus,
): boolean {
  return MAY_BECOME[to].includes(from);
}

/**
 * The failure reason MONEY-08's status check writes when Fintava has no
 * record of one of our sends (its own `404 "Transaction not found!"` and no
 * row in the sender's history, past the resend window). It is the only
 * `failed` that is our inference rather than Fintava's word, so it is the
 * only one a later sighting may undo (LedgerService.merge): Fintava's own
 * record of the reference outranks our reading of its silence.
 */
export const LEDGER_ABSENT_FAILURE =
  'Fintava has no record of this transfer, so no money moved.';

/** The failure reason when Fintava's own record says FAILURE or CANCELLED. */
export const LEDGER_FINTAVA_FAILURE = 'Fintava reports this transfer failed.';

export interface LedgerReferenceRow {
  value: string;
  kind: LedgerReferenceKind;
}

/**
 * Every reference of a sighting, trimmed, at most one per text (the most
 * specific kind wins), sorted by text so every writer takes the key locks in
 * the same order.
 */
export function ledgerReferences(r: LedgerReferences): LedgerReferenceRow[] {
  const candidates: Array<[LedgerReferenceKind, string | null | undefined]> = [
    ['ours', r.customerReference],
    ['fintava', r.fintavaReference],
    ['tagapay', r.tagapayTransRef],
    ['transaction_id', r.fintavaTransactionId],
    ['session', r.sessionId],
    ...(r.delivery ?? []).map(
      (v) =>
        ['delivery', v] as [LedgerReferenceKind, string | null | undefined],
    ),
  ];
  const byValue = new Map<string, LedgerReferenceKind>();
  for (const [kind, raw] of candidates) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '' || value.length > MAX_REFERENCE) continue;
    const held = byValue.get(value);
    if (!held || KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(held)) {
      byValue.set(value, kind);
    }
  }
  return [...byValue.entries()]
    .map(([value, kind]) => ({ value, kind }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** A safe, non-negative whole number of kobo, as BIGINT. Never rounded. */
export function koboBig(what: string, n: number, positive = false): bigint {
  if (!Number.isSafeInteger(n) || n < 0 || (positive && n === 0)) {
    throw new RangeError(
      `${what} must be a ${positive ? 'positive' : 'non-negative'} whole number of kobo.`,
    );
  }
  return BigInt(n);
}

/** BIGINT kobo back to a number, refusing anything a number cannot hold exactly. */
export function koboNumber(n: bigint): number {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || BigInt(v) !== n) {
    throw new RangeError(
      'A ledger amount is beyond what a number holds exactly.',
    );
  }
  return v;
}

type EntryRow = Prisma.FintavaLedgerEntryGetPayload<object>;

/** The rows holding a sighting's references moved while it was being merged. */
class LedgerRaceError extends Error {
  constructor() {
    super('ledger: the rows holding these references moved; run it again.');
    this.name = 'LedgerRaceError';
  }
}

/** A deadlock, a write conflict, or LedgerRaceError: safe to run again. */
function retryable(e: unknown): boolean {
  if (e instanceof LedgerRaceError) return true;
  const code = (e as { code?: unknown } | null)?.code;
  const text = e instanceof Error ? e.message : '';
  return (
    code === 'P2034' ||
    /deadlock detected|40P01|could not serialize/i.test(text)
  );
}

/** The columns a sighting carries, already in database form. */
interface Sighting {
  status: TransferStatus;
  category: EntryRow['category'];
  amountKobo: bigint;
  feeKobo: bigint;
  totalKobo: bigint;
  providerFeeKobo: bigint | null;
  wawuFeeKobo: bigint | null;
  counterpartyKind: EntryRow['counterpartyKind'];
  counterpartyName: string | null;
  counterpartyWawuUserId: string | null;
  counterpartyAccountNumber: string | null;
  counterpartyBankCode: string | null;
  counterpartyBankName: string | null;
  linkKind: string | null;
  linkTargetId: string | null;
  linkTitle: string | null;
  note: string | null;
  narration: string | null;
  customerReference: string | null;
  fintavaReference: string | null;
  tagapayTransRef: string | null;
  fintavaTransactionId: string | null;
  sessionId: string | null;
  transferId: string | null;
  paymentId: string | null;
  failureReason: string | null;
  source: string;
  sourceEventId: string | null;
  occurredAt: Date;
}

function clean(v: string | null | undefined, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, max);
}

function sightingOf(input: LedgerMovementInput, now: Date): Sighting {
  const amount = koboBig('amountKobo', input.amountKobo, true);
  const fee = koboBig('feeKobo', input.feeKobo ?? 0);
  const total =
    input.totalKobo !== undefined
      ? koboBig('totalKobo', input.totalKobo)
      : input.direction === 'out'
        ? amount + fee
        : amount;
  const cp = input.counterparty ?? null;
  const refs = input.references;
  return {
    status: input.status,
    category: input.category,
    amountKobo: amount,
    feeKobo: fee,
    totalKobo: total,
    providerFeeKobo:
      input.providerFeeKobo == null
        ? null
        : koboBig('providerFeeKobo', input.providerFeeKobo),
    wawuFeeKobo:
      input.wawuFeeKobo == null
        ? null
        : koboBig('wawuFeeKobo', input.wawuFeeKobo),
    counterpartyKind: cp?.kind ?? null,
    counterpartyName: clean(cp?.name),
    counterpartyWawuUserId: clean(cp?.wawuUserId),
    counterpartyAccountNumber: clean(cp?.accountNumber),
    counterpartyBankCode: clean(cp?.bankCode),
    counterpartyBankName: clean(cp?.bankName),
    linkKind: input.link?.kind ?? null,
    linkTargetId: clean(input.link?.targetId),
    linkTitle: clean(input.link?.title),
    note: clean(input.note),
    narration: clean(input.narration),
    customerReference: clean(refs.customerReference, MAX_REFERENCE),
    fintavaReference: clean(refs.fintavaReference, MAX_REFERENCE),
    tagapayTransRef: clean(refs.tagapayTransRef, MAX_REFERENCE),
    fintavaTransactionId: clean(refs.fintavaTransactionId, MAX_REFERENCE),
    sessionId: clean(refs.sessionId, MAX_REFERENCE),
    transferId: clean(input.transferId),
    paymentId: clean(input.paymentId),
    failureReason: clean(input.failureReason),
    source: input.source,
    sourceEventId: clean(input.sourceEventId),
    occurredAt: input.occurredAt ?? now,
  };
}

function sightingOfRow(row: EntryRow): Sighting {
  return { ...row };
}

/**
 * WAWU's ledger (task MONEY-10): one row per wallet side of each movement of
 * money, mirrored from Fintava in BIGINT kobo. Never a balance.
 *
 * Exactly once, without a read before the write: a sighting inserts its row
 * and then every reference it knows into FintavaLedgerReference, whose key
 * is (accountNumber, direction, value), with ON CONFLICT DO NOTHING. If any
 * reference was already there, the movement is already recorded: the new
 * row is folded into the one that holds it and deleted, in the same
 * transaction. Two writers racing on the same movement queue on that key;
 * the second sees the first's row once it commits and folds into it.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Records one side of one movement, or merges it into the row that has it. */
  async record(
    input: LedgerMovementInput,
    db?: Prisma.TransactionClient,
  ): Promise<LedgerRecordResult> {
    if (db) return this.recordIn(db, input);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.recordIn(tx, input));
      } catch (e) {
        // Writers racing on one movement can deadlock on its keys or see a
        // row folded away under them; Postgres rolls one back, and running
        // it again lands on the row the other wrote.
        if (attempt >= 3 || !retryable(e)) throw e;
      }
    }
  }

  /** The row ids on one side that hold any of these references. */
  async entriesFor(
    accountNumber: string,
    direction: LedgerDirection,
    references: readonly string[],
    db: Db = this.prisma,
  ): Promise<string[]> {
    if (references.length === 0) return [];
    const rows = await db.fintavaLedgerReference.findMany({
      where: { accountNumber, direction, value: { in: [...references] } },
      select: { entryId: true },
    });
    return [...new Set(rows.map((r) => r.entryId))];
  }

  /** The `out` rows, on any wallet, that hold any of these references. */
  async debitsFor(
    references: readonly string[],
    db: Db = this.prisma,
  ): Promise<string[]> {
    const refs = [...new Set(references.map((r) => r.trim()).filter(Boolean))];
    if (refs.length === 0) return [];
    const hits = await db.fintavaLedgerReference.findMany({
      where: { direction: 'out', value: { in: refs } },
      select: { entryId: true },
    });
    return [...new Set(hits.map((h) => h.entryId))].sort();
  }

  /**
   * MONEY-08: a `pending` row whose send Fintava has no record of becomes
   * `failed` with LEDGER_ABSENT_FAILURE. Locked and re-checked: a row that
   * is no longer pending, or carries a disagreement, is left alone (false).
   */
  async markAbsentFailed(entryId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const held = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "FintavaLedgerEntry"
         WHERE "id" = ${entryId} AND "status" = 'pending'
           AND "discrepancy" IS NULL
         FOR UPDATE`;
      if (held.length === 0) return false;
      await tx.fintavaLedgerEntry.update({
        where: { id: entryId },
        data: { status: 'failed', failureReason: LEDGER_ABSENT_FAILURE },
      });
      return true;
    });
  }

  /**
   * MONEY-08: records a disagreement with Fintava on a row without changing
   * anything else (the stored figures and status stand; MONEY-16 reports
   * it). A note already on the row is not written twice.
   */
  async noteDiscrepancy(entryId: string, note: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "FintavaLedgerEntry" WHERE "id" = ${entryId} FOR UPDATE`;
      const row = await tx.fintavaLedgerEntry.findUnique({
        where: { id: entryId },
        select: { discrepancy: true },
      });
      if (!row || (row.discrepancy ?? '').split('; ').includes(note)) {
        return false;
      }
      await tx.fintavaLedgerEntry.update({
        where: { id: entryId },
        data: {
          discrepancy: [row.discrepancy, note]
            .filter(Boolean)
            .join('; ')
            .slice(0, 1000),
        },
      });
      return true;
    });
  }

  private async recordIn(
    tx: Prisma.TransactionClient,
    input: LedgerMovementInput,
  ): Promise<LedgerRecordResult> {
    const refs = ledgerReferences(input.references);
    if (refs.length === 0) {
      throw new RangeError('A ledger movement needs at least one reference.');
    }
    const accountNumber = input.wallet.accountNumber;
    const direction = input.direction;
    const now = new Date();
    const s = sightingOf(input, now);
    const id = randomUUID();

    await tx.fintavaLedgerEntry.create({
      data: {
        id,
        walletKind: input.wallet.kind,
        wawuUserId:
          input.wallet.kind === 'user' ? input.wallet.wawuUserId : null,
        accountNumber,
        direction,
        ...s,
        completedAt: s.status === 'completed' ? now : null,
      },
    });

    const values = refs.map((r) => r.value);
    const kinds = refs.map((r) => r.kind);
    const inserted = await tx.$queryRaw<Array<{ value: string }>>`
      INSERT INTO "FintavaLedgerReference"
             ("accountNumber", "direction", "value", "kind", "entryId")
      SELECT ${accountNumber}, ${direction}::"FintavaLedgerDirection",
             r.value, r.kind, ${id}
        FROM unnest(${values}::text[], ${kinds}::text[]) AS r(value, kind)
       ORDER BY r.value
      ON CONFLICT DO NOTHING
      RETURNING "value"`;
    if (inserted.length === refs.length) {
      return { entryId: id, created: true, discrepancy: null };
    }

    // Already recorded under at least one of these references. Lock the
    // rows that hold them, then check they still do: a concurrent merge may
    // have folded one into another between the read and the lock (it locks
    // the rows it deletes, so once these are locked the answer is stable).
    const fresh = new Set(inserted.map((r) => r.value));
    const collided = values.filter((v) => !fresh.has(v));
    const ownersOf = async () => {
      const rows = await tx.fintavaLedgerReference.findMany({
        where: { accountNumber, direction, value: { in: collided } },
        select: { entryId: true },
      });
      return [...new Set(rows.map((r) => r.entryId))].filter((e) => e !== id);
    };
    let ownerIds = await ownersOf();
    let holders: EntryRow[] = [];
    for (let attempt = 0; attempt < 5 && holders.length === 0; attempt += 1) {
      if (ownerIds.length === 0) break;
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "FintavaLedgerEntry"
         WHERE "id" = ANY(${ownerIds}::text[])
         ORDER BY "createdAt", "id"
         FOR UPDATE`;
      const held = new Set(locked.map((r) => r.id));
      const now = await ownersOf();
      if (now.length > 0 && now.every((e) => held.has(e))) {
        holders = await tx.fintavaLedgerEntry.findMany({
          where: { id: { in: now } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
      } else {
        ownerIds = now;
      }
    }
    const [keeper, ...extra] = holders;
    if (!keeper) throw new LedgerRaceError();

    let row = keeper;
    const notes: string[] = [];
    for (const other of extra) {
      // Two rows for one side of one movement: an earlier pair of sightings
      // shared no reference, and this one names both. One row is kept.
      this.logger.warn(
        `ledger: two rows on one side of one movement were folded into one (${keeper.id})`,
      );
      const merged = this.merge(row, sightingOfRow(other), now);
      row = { ...row, ...merged.data };
      if (merged.discrepancy) notes.push(merged.discrepancy);
    }
    const merged = this.merge(row, s, now);
    row = { ...row, ...merged.data };
    if (merged.discrepancy) notes.push(merged.discrepancy);

    await tx.fintavaLedgerReference.updateMany({
      where: { entryId: { in: [id, ...extra.map((e) => e.id)] } },
      data: { entryId: keeper.id },
    });
    await tx.fintavaLedgerEntry.deleteMany({
      where: { id: { in: [id, ...extra.map((e) => e.id)] } },
    });

    const discrepancy =
      notes.length === 0
        ? keeper.discrepancy
        : [keeper.discrepancy, ...notes]
            .filter(Boolean)
            .join('; ')
            .slice(0, 1000);
    await tx.fintavaLedgerEntry.update({
      where: { id: keeper.id },
      data: {
        status: row.status,
        category: row.category,
        providerFeeKobo: row.providerFeeKobo,
        wawuFeeKobo: row.wawuFeeKobo,
        counterpartyKind: row.counterpartyKind,
        counterpartyName: row.counterpartyName,
        counterpartyWawuUserId: row.counterpartyWawuUserId,
        counterpartyAccountNumber: row.counterpartyAccountNumber,
        counterpartyBankCode: row.counterpartyBankCode,
        counterpartyBankName: row.counterpartyBankName,
        linkKind: row.linkKind,
        linkTargetId: row.linkTargetId,
        linkTitle: row.linkTitle,
        note: row.note,
        narration: row.narration,
        customerReference: row.customerReference,
        fintavaReference: row.fintavaReference,
        tagapayTransRef: row.tagapayTransRef,
        fintavaTransactionId: row.fintavaTransactionId,
        sessionId: row.sessionId,
        transferId: row.transferId,
        paymentId: row.paymentId,
        failureReason: row.failureReason,
        sourceEventId: row.sourceEventId,
        occurredAt: row.occurredAt,
        completedAt: row.completedAt,
        discrepancy,
      },
    });
    if (notes.length > 0) {
      this.logger.error(
        `ledger: a sighting disagreed with row ${keeper.id}; the stored figures are kept (${notes.join('; ')})`,
      );
    }
    return {
      entryId: keeper.id,
      created: false,
      discrepancy: notes.length ? notes.join('; ') : null,
    };
  }

  /**
   * What a second sighting adds to a row. Amounts are never changed: a
   * sighting with other figures is a disagreement, kept on `discrepancy` for
   * MONEY-16 to report. References and missing details are filled in. The
   * feature that moved the money (`send`) decides what the row is for
   * (category, counterparty, link, note); a webhook or a lookup only fills
   * what is empty. The status only moves forward (ledgerStatusMayMove).
   */
  private merge(
    row: EntryRow,
    s: Sighting,
    now: Date,
  ): { data: Partial<EntryRow>; discrepancy: string | null } {
    const data: Partial<EntryRow> = {};
    const fill = <K extends keyof Sighting & keyof EntryRow>(k: K) => {
      if ((row[k] === null || row[k] === undefined) && s[k] !== null) {
        (data as Record<string, unknown>)[k] = s[k];
      }
    };
    const owns = s.source === 'send';
    const take = <K extends keyof Sighting & keyof EntryRow>(k: K) => {
      if (owns && s[k] !== null) (data as Record<string, unknown>)[k] = s[k];
      else fill(k);
    };

    for (const k of [
      'customerReference',
      'fintavaReference',
      'tagapayTransRef',
      'fintavaTransactionId',
      'sessionId',
      'narration',
      'failureReason',
      'sourceEventId',
    ] as const) {
      fill(k);
    }
    for (const k of [
      'providerFeeKobo',
      'wawuFeeKobo',
      'counterpartyKind',
      'counterpartyName',
      'counterpartyWawuUserId',
      'counterpartyAccountNumber',
      'counterpartyBankCode',
      'counterpartyBankName',
      'linkKind',
      'linkTargetId',
      'linkTitle',
      'note',
      'transferId',
      'paymentId',
    ] as const) {
      take(k);
    }
    if (owns) data.category = s.category;

    const differs: string[] = [];
    const absentFailure =
      row.status === 'failed' && row.failureReason === LEDGER_ABSENT_FAILURE;
    if (absentFailure && (s.status === 'pending' || s.status === 'completed')) {
      // Marked failed because Fintava had no record of it (MONEY-08), and
      // now a sighting of the same reference exists: a resend under the same
      // reference, or a record Fintava did not serve before. Fintava's
      // record wins; the earlier reading is kept on `discrepancy` for review.
      data.status = s.status;
      data.failureReason = null;
      if (s.status === 'completed' && row.completedAt === null) {
        data.completedAt = now;
      }
      differs.push(`status failed (no record at Fintava) vs ${s.status}`);
    } else if (ledgerStatusMayMove(row.status, s.status)) {
      data.status = s.status;
      if (s.status === 'completed' && row.completedAt === null) {
        data.completedAt = now;
      }
    } else if (
      (row.status === 'completed' && s.status === 'failed') ||
      (row.status === 'failed' && s.status === 'completed')
    ) {
      // Fintava said one and now says the other (U-1). Neither is applied
      // over the other: the stored status stands and the disagreement is
      // recorded, as for an amount.
      differs.push(`status ${row.status} vs ${s.status}`);
    }
    if (absentFailure && s.status === 'failed' && s.failureReason) {
      data.failureReason = s.failureReason;
    }
    if (s.occurredAt.getTime() < row.occurredAt.getTime()) {
      data.occurredAt = s.occurredAt;
    }

    if (s.amountKobo !== row.amountKobo) {
      differs.push(`amountKobo ${row.amountKobo} vs ${s.amountKobo}`);
    }
    if (s.feeKobo !== row.feeKobo) {
      differs.push(`feeKobo ${row.feeKobo} vs ${s.feeKobo}`);
    }
    if (s.totalKobo !== row.totalKobo) {
      differs.push(`totalKobo ${row.totalKobo} vs ${s.totalKobo}`);
    }
    return {
      data,
      discrepancy: differs.length
        ? `${s.source} sighting: ${differs.join(', ')}`
        : null,
    };
  }

  /**
   * A debit came back (`debit_transfer_reversal`). The reversed movement's
   * row becomes `reversed` and keeps what Fintava reported; no second row is
   * ever written for it. The row is found by any of the references on an
   * `out` side; none or more than one is reported, never guessed.
   */
  async applyReversal(
    input: LedgerReversalInput,
    db?: Prisma.TransactionClient,
  ): Promise<LedgerReversalResult> {
    const run = async (tx: Prisma.TransactionClient) => {
      const refs = [
        ...new Set(input.references.map((r) => r.trim()).filter(Boolean)),
      ];
      if (refs.length === 0) return { state: 'no_match' } as const;
      const ids = await this.debitsFor(refs, tx);
      if (ids.length === 0) return { state: 'no_match' } as const;
      if (ids.length > 1) {
        return { state: 'ambiguous', entryIds: ids } as const;
      }
      const [entryId] = ids;
      await tx.$queryRaw`SELECT "id" FROM "FintavaLedgerEntry" WHERE "id" = ${entryId} FOR UPDATE`;
      const row = await tx.fintavaLedgerEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      const opt = (n: number | null) =>
        n === null ? null : koboBig('reversal amount', n);
      const data: Prisma.FintavaLedgerEntryUpdateInput = {};
      if (ledgerStatusMayMove(row.status, 'reversed')) data.status = 'reversed';
      if (row.reversedAt === null) {
        data.reversedAt = input.at;
        data.reversalReference = input.reversalReference;
        data.reversalAmountKobo = opt(input.amountKobo);
        data.reversalChargesKobo = opt(input.chargesKobo);
        data.reversalTotalKobo = opt(input.totalKobo);
      }
      if (Object.keys(data).length === 0) {
        return { state: 'applied', entryId, changed: false } as const;
      }
      await tx.fintavaLedgerEntry.update({ where: { id: entryId }, data });
      return { state: 'applied', entryId, changed: true } as const;
    };
    if (db) return run(db);
    return this.prisma.$transaction(run);
  }
}
