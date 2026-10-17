import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type {
  LedgerDirection,
  LedgerMovementInput,
} from '../../money/ledger/ledger.interface';
import {
  LEDGER_FINTAVA_FAILURE,
  LedgerProviderConflictError,
  type LedgerService,
} from '../../money/ledger/ledger.service';
import type { TransferStatus } from '../../money/money-view.type';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { isNuvionId } from '../areas/accounts';
import {
  type BookTransferReading,
  NUVION_BOOK_TRANSFER,
  type NuvionBookArea,
  readBookTransfer,
} from '../areas/book';
import {
  isBookNuvionStatus,
  type BookTransferRow,
  type NuvionBookStore,
} from '../areas/book-store';
import { nuvionTransferStatus } from '../nuvion-ledger-delivery';
import { NUVION_ACCOUNTS_WAIT_MS } from './accounts';
import type {
  NuvionDelivery,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

const done = (note: string): NuvionHandlerResult => ({ outcome: 'done', note });
const failed = (note: string): NuvionHandlerResult => ({
  outcome: 'failed',
  note,
});

/** The ledger's two sides of a transfer, the sender's debit first. */
const SIDES: readonly LedgerDirection[] = ['out', 'in'];

/** What each event expects Nuvion's own record to say now. */
const EXPECTED: Record<string, readonly TransferStatus[] | null> = {
  // A queued transfer may already be finished by the time it is read.
  'outflows.created': null,
  'outflows.completed': ['completed', 'reversed'],
  'outflows.failed': ['failed'],
  'outflows.cancelled': ['failed'],
  'outflows.refunded': ['reversed'],
};

/**
 * Book transfers' deliveries (task NUV-05): `outflows.created`,
 * `.completed`, `.failed`, `.cancelled` and `.refunded` for a transfer this
 * server sent, reaching the ledger once.
 *
 * **Never on the delivery's word.** Nuvion's guides say to read the
 * transfer again before acting, so every event runs the same steps: the
 * delivery names a transfer; the log (`NuvionBookTransfer`) says whether it
 * is one of ours (by Nuvion's id or our `unique_reference`; a transfer the
 * log does not hold is another rail's, a person's own move on Nuvion's
 * dashboard, or a card's, and is left alone); Nuvion is asked for it
 * (`GET /transfers/{id}`) and its record must be the transfer we sent, the
 * same account, amount, rail and reference; and what the ledger is told is
 * that record's status, whatever the event said and whatever order the
 * events came in. A `.completed` after a `.failed` changes nothing the
 * record does not say, so any order and any number of copies reach the same
 * rows: the ledger only moves a row forward (LedgerService.merge), and a
 * second sighting of the state a row already has changes nothing.
 *
 * **What it writes.** It merges Nuvion's state into the ledger rows the
 * sending feature already wrote (a payment's two pending rows) and never
 * makes a row of its own: a hold's release or refund is written by the hold
 * when it settles (MONEY-18), so a row that is not there yet is that
 * feature's to write. `successful` completes both sides at the charge
 * Nuvion's record states (a charge other than the quoted one is the
 * ledger's stop, and the payment completes at it: MONEY-17 round 8);
 * `failed` (a cancelled transfer is `failed` with a reason) fails both;
 * `reversed` (an `outflows.refunded` of a completed transfer) reverses
 * both. A payment hears of it at once from the ledger
 * (`LedgerService.onPaymentSettled`).
 *
 * **Waiting is not failing.** An event ahead of Nuvion's own record (a
 * `.completed` while the record still says `pending`), Nuvion out of
 * reach, a transfer the log does not hold yet: the delivery waits and is
 * tried again (1, 2, 4 ... minutes), and is kept for review past
 * NUVION_ACCOUNTS_WAIT_MS. A record that is not the transfer we sent, or a
 * ledger that cannot take it, is a stop kept for review, never a guess.
 */
export class NuvionBookRecorder {
  private readonly logger = new Logger('NuvionBookTransfers');

  constructor(
    private readonly prisma: PrismaService,
    private readonly area: NuvionBookArea,
    private readonly store: NuvionBookStore,
    private readonly ledger: LedgerService,
  ) {}

  async onOutflow(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const read = readBookTransfer(d.data);
    if (!read.ok) return failed(`${read.why}; nothing changed`);
    const t = read.transfer;
    const refunded = d.event === 'outflows.refunded';

    // Which rail: a card's refund or a payout is not a book transfer. A
    // book transfer's reversal may arrive as a credit record whose own id
    // and reference are not ours; it names the transfer it reverses.
    if (t.paymentType !== NUVION_BOOK_TRANSFER) {
      return done(
        `${t.paymentType ?? 'a transfer of no named rail'}: not a book transfer`,
      );
    }

    const row = await this.rowOf(t, refunded);
    if (!row) {
      return done('not a transfer WAWU sent: left alone');
    }

    // The transfer the delivery is about (for a reversal's credit record, the
    // transfer it reverses) must be the one the log holds under our reference.
    const named = refunded ? (t.sourcePaymentId ?? t.id) : t.id;
    if (!isNuvionId(named)) {
      return failed('the delivery names no transfer id; nothing changed');
    }
    if (row.nuvionId !== null && named !== row.nuvionId) {
      const note = `the delivery names another transfer (${named}) than the one the log holds under our reference`;
      this.logger.error(`outflows: ${note} (review)`);
      return failed(`${note}; nothing changed`);
    }
    const id = row.nuvionId ?? named;

    let fresh: BookTransferReading;
    try {
      fresh = await this.area.readOf(row, id);
    } catch (e) {
      if (e instanceof WalletProviderError) {
        if (e.kind === 'bad_response') {
          // Nuvion's record is not the transfer we sent.
          this.logger.error(
            `outflows: Nuvion's record is not the transfer we sent (${e.messages.join('; ')}) (review)`,
          );
          return failed(
            `Nuvion's record is not the transfer we sent (${e.messages.join('; ')}); nothing changed (review)`,
          );
        }
        return this.waitOrFail(
          d,
          `Nuvion could not read the transfer back (${e.kind})`,
        );
      }
      throw e;
    }

    // Nuvion's own record into the log, forward only.
    if (!isBookNuvionStatus(fresh.status)) {
      return failed(
        `Nuvion's transfer status "${fresh.status}" is not one we know; nothing changed (review)`,
      );
    }
    const kept =
      (await this.store.recordRead(
        row.reference,
        {
          nuvionId: fresh.id,
          status: fresh.status,
          statusReason: fresh.statusReason,
          feeKobo: fresh.feeStated ? BigInt(fresh.feeKobo) : null,
        },
        new Date(),
      )) ?? row;

    const outcome = nuvionTransferStatus(fresh.status);
    // An event ahead of Nuvion's own record is not acted on: it waits.
    const expected = EXPECTED[d.event] ?? null;
    if (
      expected !== null &&
      (outcome === null || !expected.includes(outcome))
    ) {
      if (outcome === 'pending' || (refunded && outcome === 'completed')) {
        return this.waitOrFail(
          d,
          `${d.event} came but Nuvion's record says ${fresh.status}`,
        );
      }
      if (outcome === null) {
        return failed(
          `Nuvion's transfer status "${fresh.status}" is not one we know; nothing changed (review)`,
        );
      }
      // The record is somewhere else than this event expects (a late
      // `.failed` for a transfer that has completed): the record is the
      // truth, and what it says is applied below.
    }

    if (
      outcome !== 'completed' &&
      outcome !== 'failed' &&
      outcome !== 'reversed'
    ) {
      return done(`the transfer is ${fresh.status}; nothing to record yet`);
    }
    let notes: string[];
    try {
      notes = await this.toLedger(d, kept, fresh, outcome);
    } catch (e) {
      if (e instanceof LedgerProviderConflictError) {
        return failed(`${e.message}`);
      }
      throw e;
    }
    return done(
      `${fresh.status}${notes.length > 0 ? `: ${notes.join('; ')}` : ''}`,
    );
  }

  /** The log row a delivery's transfer is, or null when it is not ours. */
  private async rowOf(
    t: BookTransferReading,
    refunded: boolean,
  ): Promise<BookTransferRow | null> {
    const ids = [
      ...new Set(
        [refunded ? t.sourcePaymentId : null, t.id].filter(
          (x): x is string => x !== null && isNuvionId(x),
        ),
      ),
    ];
    for (const id of ids) {
      const byId = await this.store.byNuvionId(id);
      if (byId) return byId;
    }
    if (t.uniqueReference !== null) {
      const byRef = await this.store.byReference(t.uniqueReference);
      if (byRef) return byRef;
    }
    return null;
  }

  /**
   * Merges Nuvion's state into the rows the sender wrote. Each side is found
   * by (account number, direction, our reference): the same key the sender's
   * own write used, so a second copy of this very event finds the rows
   * already moved and changes nothing.
   */
  private async toLedger(
    d: NuvionDelivery,
    row: BookTransferRow,
    t: BookTransferReading,
    outcome: 'completed' | 'failed' | 'reversed',
  ): Promise<string[]> {
    const notes: string[] = [];
    for (const side of SIDES) {
      const accountNumber =
        side === 'out' ? row.fromAccountNumber : row.toAccountNumber;
      const ids = await this.ledger.entriesFor(accountNumber, side, [
        row.reference,
      ]);
      if (ids.length === 0) {
        // A hold's release or refund is written by the hold when it settles.
        notes.push(`no ${side} row yet: the sender records it`);
        continue;
      }
      if (ids.length > 1) {
        notes.push(`${ids.length} ${side} rows hold this reference (review)`);
        this.logger.error(
          `outflows: ${ids.length} ledger rows hold one reference on the ${side} side; nothing changed (review)`,
        );
        continue;
      }
      const e = await this.prisma.fintavaLedgerEntry.findUnique({
        where: { id: ids[0] },
        select: {
          walletKind: true,
          wawuUserId: true,
          accountNumber: true,
          category: true,
          amountKobo: true,
          feeKobo: true,
          totalKobo: true,
          wawuFeeKobo: true,
        },
      });
      if (!e) continue;
      const amount = Number(t.amountKobo);
      // The charge: Nuvion's record states it on a completed debit; a failed
      // or reversed transfer owes nothing, so the row's own figures stand.
      // A send's row also holds WAWU's fee as quoted (R-10): Nuvion's charge
      // carries none of it, WAWU's own transfer moves it once the send is
      // confirmed (FIX-52), so the row keeps it beside Nuvion's.
      const wawuFee = Number(e.wawuFeeKobo ?? 0n);
      const charge =
        outcome === 'completed' && side === 'out' && t.feeStated
          ? {
              feeKobo: t.feeKobo + wawuFee,
              totalKobo: amount + t.feeKobo + wawuFee,
              ...(wawuFee > 0
                ? { providerFeeKobo: t.feeKobo, wawuFeeKobo: wawuFee }
                : {}),
            }
          : side === 'out'
            ? {
                feeKobo: Number(e.feeKobo),
                totalKobo: Number(e.totalKobo),
              }
            : { feeKobo: 0, totalKobo: amount };
      const input: LedgerMovementInput = {
        wallet:
          e.walletKind === 'merchant' || !e.wawuUserId
            ? { kind: 'merchant', accountNumber: e.accountNumber }
            : {
                kind: 'user',
                wawuUserId: e.wawuUserId,
                accountNumber: e.accountNumber,
              },
        direction: side,
        status: outcome,
        category: e.category,
        amountKobo: amount,
        ...charge,
        // A record that states no charge says nothing against the one the
        // row holds.
        figuresStand: side === 'out' && outcome === 'completed' && !t.feeStated,
        references: {
          customerReference: row.reference,
          fintavaReference: t.id,
          fintavaTransactionId: t.id,
        },
        failureReason: outcome === 'failed' ? LEDGER_FINTAVA_FAILURE : null,
        source: 'webhook',
        sourceEventId: d.eventId,
        occurredAt: t.createdAt,
      };
      const r = await this.ledger.record(input);
      if (r.discrepancy) {
        notes.push(`${side}: ${r.discrepancy}`);
      }
    }
    return notes;
  }

  /** `wait`, or `failed` for review once the delivery has waited too long. */
  private waitOrFail(d: NuvionDelivery, note: string): NuvionHandlerResult {
    if (Date.now() - d.receivedAt.getTime() > NUVION_ACCOUNTS_WAIT_MS) {
      return failed(`${note}; waited past the limit, kept for review`);
    }
    return { outcome: 'wait', note };
  }
}
