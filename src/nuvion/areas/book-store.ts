import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { isUniqueViolation } from '../../money/prisma-unique';
import { isNuvionId, readNuvionWalletId } from './accounts';

/**
 * The records the book transfer area needs beyond Nuvion itself (task
 * NUV-05): which Nuvion account a number WAWU holds names, and the log of
 * every book transfer this server sent. Kept behind an interface so the area
 * is tested against the Nuvion stand-in with an in-memory copy, and run
 * against Postgres (`PrismaNuvionBookStore`) everywhere else.
 */

/** The statuses a log row may hold (the migration's CHECK says the same). */
export const BOOK_STATUSES = [
  'sending',
  'refused',
  'pending',
  'processing',
  'successful',
  'failed',
  'reversed',
] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

/** Nuvion's own words for a transfer (the log's statuses after an answer). */
export type BookNuvionStatus = Exclude<BookStatus, 'sending' | 'refused'>;

export function isBookNuvionStatus(s: string): s is BookNuvionStatus {
  return (
    s === 'pending' ||
    s === 'processing' ||
    s === 'successful' ||
    s === 'failed' ||
    s === 'reversed'
  );
}

/**
 * Which statuses a row may move to from where it is. A status only moves
 * forward, and a settled one is never undone by a late `pending`:
 * - `sending`: any answer;
 * - `refused`: sending again (the reference was not used up);
 * - `pending` to `processing`, `successful` or `failed`;
 * - `processing` to `successful` or `failed`;
 * - `successful` to `reversed` (and any unfinished state to `reversed`, for a
 *   transfer that was completed and reversed before it was read);
 * - `failed` and `reversed` are final.
 * A move to the status it already has is no move.
 */
const MAY_MOVE_FROM: Record<BookStatus, readonly BookStatus[]> = {
  sending: ['refused'],
  refused: [],
  pending: ['sending'],
  processing: ['sending', 'pending'],
  successful: ['sending', 'pending', 'processing'],
  failed: ['sending', 'pending', 'processing'],
  // Completed and reversed before anyone read it: from any unfinished or
  // completed state. A failed transfer is never reversed.
  reversed: ['sending', 'pending', 'processing', 'successful'],
};

export function bookStatusMayMove(from: string, to: BookStatus): boolean {
  return (MAY_MOVE_FROM[to] as readonly string[]).includes(from);
}

/** One account the area can name to Nuvion. */
export interface BookAccountRef {
  /** Nuvion's account id. */
  accountId: string;
  /** The entity that owns it; null for WAWU's operational account (parent entity). */
  entityId: string | null;
  /** The number WAWU names this side by (a person's account number, or the `nuvion_ban`). */
  accountNumber: string;
  /** What a book transfer names its receiver by. */
  nuvionBan: string;
  operational: boolean;
}

/** A person's naira account as WAWU's records hold it. */
export interface BookPersonAccount {
  entityId: string;
  accountId: string;
  /** The active NUBAN, or null while none is recorded. */
  accountNumber: string | null;
  /** Recorded on the entity when `accounts.created` came; null before. */
  nuvionBan: string | null;
}

/** One row of the log. */
export interface BookTransferRow {
  id: string;
  reference: string;
  nuvionId: string | null;
  fromAccountId: string;
  fromEntityId: string | null;
  fromOperational: boolean;
  fromAccountNumber: string;
  toAccountId: string;
  toEntityId: string | null;
  toOperational: boolean;
  toAccountNumber: string;
  toNuvionBan: string;
  amountKobo: bigint;
  feeKobo: bigint | null;
  narration: string | null;
  status: BookStatus;
  statusReason: string | null;
  sentAt: Date;
  answeredAt: Date | null;
  readAt: Date | null;
}

/** What a send is written down as before it goes out. */
export interface BookTransferAttempt {
  reference: string;
  from: BookAccountRef;
  to: BookAccountRef;
  amountKobo: bigint;
  narration: string;
}

/** What Nuvion's record of a transfer tells the log. */
export interface BookTransferRead {
  nuvionId: string;
  status: BookNuvionStatus;
  statusReason: string | null;
  feeKobo: bigint | null;
}

export interface NuvionBookStore {
  /**
   * A person's naira account by any name WAWU or Nuvion knows it by: the
   * account number, the account id, the `nuvion_ban` (any case) or the
   * wallet id the accounts area hands out (`<entity>:<account>`). Null when
   * no Nuvion wallet of ours has it. Two accounts matching is a stop
   * (`ambiguous`), never a guess.
   */
  findPersonAccount(
    name: string,
  ): Promise<BookPersonAccount | 'ambiguous' | null>;
  /**
   * Writes the attempt down unless its reference is already in the log.
   * Answers the row that holds the reference and whether this call wrote it.
   */
  begin(
    attempt: BookTransferAttempt,
    now: Date,
  ): Promise<{ row: BookTransferRow; created: boolean }>;
  byReference(reference: string): Promise<BookTransferRow | null>;
  byNuvionId(id: string): Promise<BookTransferRow | null>;
  /** A refused send's row, ready to be sent again under the same reference. */
  reopen(reference: string, now: Date): Promise<BookTransferRow>;
  /** Nuvion answered that it made nothing (or the request never reached it). */
  markRefused(
    reference: string,
    reason: string,
    now: Date,
  ): Promise<BookTransferRow | null>;
  /**
   * Moves the row forward from Nuvion's record. The id is kept once and never
   * replaced; the status only moves where `bookStatusMayMove` says. Answers
   * the row as it stands, or null when there is none.
   */
  recordRead(
    reference: string,
    read: BookTransferRead,
    now: Date,
    opts?: { answered?: boolean },
  ): Promise<BookTransferRow | null>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

type DbRow = Prisma.NuvionBookTransferGetPayload<object>;

function rowOf(r: DbRow): BookTransferRow {
  return {
    id: r.id,
    reference: r.reference,
    nuvionId: r.nuvionId,
    fromAccountId: r.fromAccountId,
    fromEntityId: r.fromEntityId,
    fromOperational: r.fromOperational,
    fromAccountNumber: r.fromAccountNumber,
    toAccountId: r.toAccountId,
    toEntityId: r.toEntityId,
    toOperational: r.toOperational,
    toAccountNumber: r.toAccountNumber,
    toNuvionBan: r.toNuvionBan,
    amountKobo: r.amountKobo,
    feeKobo: r.feeKobo,
    narration: r.narration,
    status: r.status as BookStatus,
    statusReason: r.statusReason,
    sentAt: r.sentAt,
    answeredAt: r.answeredAt,
    readAt: r.readAt,
  };
}

export class PrismaNuvionBookStore implements NuvionBookStore {
  constructor(private readonly prisma: PrismaService) {}

  async findPersonAccount(
    name: string,
  ): Promise<BookPersonAccount | 'ambiguous' | null> {
    const n = name.trim();
    if (n === '' || n.length > 130) return null;
    const found = new Map<string, BookPersonAccount>();
    const add = (p: BookPersonAccount) => {
      const held = found.get(p.accountId);
      found.set(p.accountId, {
        ...held,
        ...p,
        nuvionBan: p.nuvionBan ?? held?.nuvionBan ?? null,
        accountNumber: p.accountNumber ?? held?.accountNumber ?? null,
      });
    };

    const ids = readNuvionWalletId(n);
    if (ids) {
      add({ ...ids, accountNumber: null, nuvionBan: null });
    }
    // The wallet WAWU's records hold, by the number a service names it by.
    const wallets = await this.prisma.fintavaWallet.findMany({
      where: { accountNumber: n, provider: 'nuvion' },
      select: { walletId: true, customerId: true, accountNumber: true },
      take: 2,
    });
    for (const w of wallets) {
      const wid = readNuvionWalletId(w.walletId);
      if (wid) {
        add({
          entityId: wid.entityId,
          accountId: wid.accountId,
          accountNumber: w.accountNumber,
          nuvionBan: null,
        });
      }
    }
    // The entity record, by the account id or the `nuvion_ban` (as written,
    // upper or lower case: an exact match on a unique key, never a scan).
    const entities = await this.prisma.nuvionEntity.findMany({
      where: {
        OR: [
          { accountId: n },
          {
            nuvionBan: {
              in: [...new Set([n, n.toUpperCase(), n.toLowerCase()])],
            },
          },
        ],
      },
      select: {
        entityId: true,
        accountId: true,
        accountNumber: true,
        nuvionBan: true,
      },
      take: 3,
    });
    for (const e of entities) {
      if (e.entityId && e.accountId) {
        add({
          entityId: e.entityId,
          accountId: e.accountId,
          accountNumber: e.accountNumber,
          nuvionBan: e.nuvionBan,
        });
      }
    }
    if (found.size === 0) return null;
    if (found.size > 1) return 'ambiguous';
    const [one] = [...found.values()];
    if (!isNuvionId(one.entityId) || !isNuvionId(one.accountId)) return null;
    // Fill what the first source did not hold from the entity record.
    if (one.nuvionBan === null || one.accountNumber === null) {
      const e = await this.prisma.nuvionEntity.findUnique({
        where: { accountId: one.accountId },
        select: { nuvionBan: true, accountNumber: true, entityId: true },
      });
      if (e && e.entityId === one.entityId) {
        return {
          ...one,
          nuvionBan: one.nuvionBan ?? e.nuvionBan,
          accountNumber: one.accountNumber ?? e.accountNumber,
        };
      }
    }
    return one;
  }

  async begin(
    attempt: BookTransferAttempt,
    now: Date,
  ): Promise<{ row: BookTransferRow; created: boolean }> {
    try {
      const made = await this.prisma.nuvionBookTransfer.create({
        data: {
          reference: attempt.reference,
          fromAccountId: attempt.from.accountId,
          fromEntityId: attempt.from.entityId,
          fromOperational: attempt.from.operational,
          fromAccountNumber: attempt.from.accountNumber,
          toAccountId: attempt.to.accountId,
          toEntityId: attempt.to.entityId,
          toOperational: attempt.to.operational,
          toAccountNumber: attempt.to.accountNumber,
          toNuvionBan: attempt.to.nuvionBan,
          amountKobo: attempt.amountKobo,
          narration: attempt.narration,
          status: 'sending',
          sentAt: now,
        },
      });
      return { row: rowOf(made), created: true };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const held = await this.byReference(attempt.reference);
      if (!held) throw e;
      return { row: held, created: false };
    }
  }

  async byReference(reference: string): Promise<BookTransferRow | null> {
    const r = await this.prisma.nuvionBookTransfer.findUnique({
      where: { reference },
    });
    return r ? rowOf(r) : null;
  }

  async byNuvionId(id: string): Promise<BookTransferRow | null> {
    const r = await this.prisma.nuvionBookTransfer.findUnique({
      where: { nuvionId: id },
    });
    return r ? rowOf(r) : null;
  }

  async reopen(reference: string, now: Date): Promise<BookTransferRow> {
    await this.prisma.nuvionBookTransfer.updateMany({
      where: { reference, status: 'refused', nuvionId: null },
      data: {
        status: 'sending',
        statusReason: null,
        sentAt: now,
        answeredAt: null,
      },
    });
    const r = await this.byReference(reference);
    if (!r) throw new Error('The book transfer log lost a row.');
    return r;
  }

  async markRefused(
    reference: string,
    reason: string,
    now: Date,
  ): Promise<BookTransferRow | null> {
    await this.prisma.nuvionBookTransfer.updateMany({
      where: { reference, status: 'sending', nuvionId: null },
      data: {
        status: 'refused',
        statusReason: reason.slice(0, 300),
        answeredAt: now,
      },
    });
    return this.byReference(reference);
  }

  async recordRead(
    reference: string,
    read: BookTransferRead,
    now: Date,
    opts: { answered?: boolean } = {},
  ): Promise<BookTransferRow | null> {
    // The id is kept once: an update that would replace one is not made (the
    // caller compares the transfer with the row before it gets here).
    await this.prisma.nuvionBookTransfer.updateMany({
      where: {
        reference,
        OR: [{ nuvionId: null }, { nuvionId: read.nuvionId }],
      },
      data: {
        nuvionId: read.nuvionId,
        readAt: now,
        ...(opts.answered ? { answeredAt: now } : {}),
        ...(read.feeKobo !== null ? { feeKobo: read.feeKobo } : {}),
      },
    });
    // The status, only where it may move (a conditional update, so two
    // readers at once cannot undo each other).
    const from = (Object.keys(MAY_MOVE_FROM) as BookStatus[]).filter((s) =>
      bookStatusMayMove(s, read.status),
    );
    if (from.length > 0) {
      await this.prisma.nuvionBookTransfer.updateMany({
        where: { reference, nuvionId: read.nuvionId, status: { in: from } },
        data: {
          status: read.status,
          statusReason: read.statusReason?.slice(0, 300) ?? null,
        },
      });
    }
    return this.byReference(reference);
  }
}
