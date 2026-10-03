import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FintavaClient } from '../../fintava/fintava-client';
import { FintavaError } from '../../fintava/fintava-error';
import { decideFintavaRetry } from '../../fintava/fintava-reconcile';
import type {
  FintavaReconciliation,
  FintavaRetryDecision,
  FintavaSender,
  FintavaSendKind,
  FintavaTransaction,
} from '../../fintava/fintava.interface';
import type { TransferStatus } from '../money-view.type';
import {
  LEDGER_CONFIG_KEYS,
  LEDGER_STATUS_DEFAULTS,
  ledgerStatusCheckAfterMs,
} from './ledger-config';
import type { LedgerWallet } from './ledger.interface';
import {
  koboNumber,
  LEDGER_FINTAVA_FAILURE,
  LedgerService,
} from './ledger.service';
import { ledgerStatusOf } from './ledger-webhook';

/** What one status check did to one ledger row. */
export type LedgerStatusOutcome =
  /** Fintava's record settled it: completed, or failed. */
  | 'settled'
  /** Fintava has no record of our send past the resend window: failed, no money moved. */
  | 'failed_absent'
  /** Still pending at Fintava, or Fintava could not say: left pending. */
  | 'waiting'
  /** Fintava's record disagrees with the row: recorded on the row, nothing moved. */
  | 'disagrees'
  /** Not pending (settled, failed or reversed already), or not found. */
  | 'skipped';

export interface LedgerStatusCheck {
  outcome: LedgerStatusOutcome;
  /** The row's status after the check; null when there is no such row. */
  status: TransferStatus | null;
  /**
   * For one of our sends checked by our reference: what MONEY-06's rules
   * (decideFintavaRetry) allow its sender to do next. Advice only: this
   * service never sends money, and a resend is the sending feature's, under
   * its own lock on the payment (one retry at a time, MONEY-06).
   */
  decision: FintavaRetryDecision | null;
  /**
   * What Fintava answered about the row's movement this time: `found`,
   * `absent` (its own "not found", and for our reference no history row
   * either) or `unknown`; null when Fintava was not asked.
   */
  fintava: 'found' | 'absent' | 'unknown' | null;
  /** Why, in a few words, for logs and tests. Never personal data. */
  why: string;
}

type Entry = Prisma.FintavaLedgerEntryGetPayload<object>;

const MINUTE = 60_000;

/**
 * Status checks and the pending sweep (task MONEY-08).
 *
 * A transfer stays `pending` in the ledger until something says how it
 * ended. Normally that is its Fintava webhook (MONEY-07, applied by
 * MONEY-10's consumer). When the webhook never comes, this sweep asks
 * Fintava instead: the MONEY-06 client's lookup by reference and the
 * sender's history (Fintava's status endpoint, `reconcile`), the same
 * reconcile-pending pattern as the bills sweep (`reconcile-pending-bills`),
 * on the ledger rather than on the webhook rows (BACKEND_GAPS G-33).
 *
 * What it does with each answer, and what it never does:
 * - Found SUCCESS: the row is completed. Found FAILURE or CANCELLED: the row
 *   is failed. Both merge through LedgerService.record, so a webhook that
 *   arrives too, before or after, lands on the same row (exactly once).
 * - Found PENDING or ONGOING, a lookup answering `{}`, or Fintava out of
 *   reach: nothing changes; it is asked again later, backing off. An
 *   unknown outcome stays pending; it is never guessed.
 * - Fintava's own `404 "Transaction not found!"` for OUR reference and no
 *   row in the sender's history, once the resend window has passed (the
 *   only `absent` MONEY-06 accepts): the send never happened, so the row is
 *   failed with LEDGER_ABSENT_FAILURE (no money moved). A later sighting of
 *   that reference undoes it (LedgerService.merge).
 * - Fintava's record has another amount than the row: a stop. The
 *   disagreement is written on the row's `discrepancy`, the status is not
 *   moved, and the sweep leaves the row for review (MONEY-16).
 * - It never sends money: no resend, and no refund of a failed send.
 *   Fintava reverses a failed bank send itself (`debit_transfer_reversal`),
 *   which MONEY-10 applies as the row's `reversed` status; WAWU paying it
 *   back as well would pay it twice.
 * - It never adds anything up: the balance is Fintava's (MONEY-11).
 */
@Injectable()
export class LedgerStatusService {
  private readonly logger = new Logger(LedgerStatusService.name);
  private readonly checkAfterMs: number;
  private sweeping = false;
  /** Rows left pending, and when each may be asked about again (per process). */
  private readonly retryAt = new Map<string, { at: number; delayMs: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fintava: FintavaClient,
    private readonly ledger: LedgerService,
    config: ConfigService,
  ) {
    this.checkAfterMs = ledgerStatusCheckAfterMs(
      config.get<string>(LEDGER_CONFIG_KEYS.statusCheckAfterMinutes),
    );
  }

  /**
   * The pending sweep: every `pending` row older than the check-after time,
   * oldest first, except rows resting after an unclear answer and rows
   * already holding a disagreement. One pass at a time per process; a
   * second process checking the same row lands on the same row.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'ledger-status-sweep' })
  async sweep(now = new Date()): Promise<Record<LedgerStatusOutcome, number>> {
    const counts: Record<LedgerStatusOutcome, number> = {
      settled: 0,
      failed_absent: 0,
      waiting: 0,
      disagrees: 0,
      skipped: 0,
    };
    if (this.sweeping) return counts;
    this.sweeping = true;
    try {
      const resting = [...this.retryAt.entries()]
        .filter(([, r]) => r.at > now.getTime())
        .map(([id]) => id);
      const due = await this.prisma.fintavaLedgerEntry.findMany({
        where: {
          status: 'pending',
          discrepancy: null,
          createdAt: { lte: new Date(now.getTime() - this.checkAfterMs) },
          ...(resting.length ? { id: { notIn: resting } } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: LEDGER_STATUS_DEFAULTS.batch,
        select: { id: true },
      });
      for (const { id } of due) {
        try {
          const c = await this.check(id, now);
          counts[c.outcome] += 1;
        } catch (e) {
          // The name only: a message can quote what Fintava sent.
          this.logger.error(
            `ledger status: a pending row could not be checked (${(e as Error).name ?? 'Error'}); it stays pending`,
          );
          this.backOff(id, now);
        }
      }
      if (counts.settled + counts.failed_absent + counts.disagrees > 0) {
        this.logger.log(
          `ledger status: ${counts.settled} settled, ${counts.failed_absent} failed with no record at Fintava, ${counts.disagrees} disagree, ${counts.waiting} waiting`,
        );
      }
      return counts;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Asks Fintava how one `pending` ledger row ended and settles it if
   * Fintava knows. The sweep calls it; so may a sending feature before it
   * decides to retry (WALLET-09), using the returned decision.
   */
  async check(entryId: string, now = new Date()): Promise<LedgerStatusCheck> {
    const result = await this.checkOnce(entryId, now);
    if (result.outcome === 'waiting') this.backOff(entryId, now);
    else this.retryAt.delete(entryId);
    return result;
  }

  private async checkOnce(
    entryId: string,
    now: Date,
  ): Promise<LedgerStatusCheck> {
    const e = await this.prisma.fintavaLedgerEntry.findUnique({
      where: { id: entryId },
    });
    if (!e) {
      return {
        outcome: 'skipped',
        status: null,
        decision: null,
        fintava: null,
        why: 'none',
      };
    }
    if (e.status !== 'pending') {
      return {
        outcome: 'skipped',
        status: e.status,
        decision: null,
        fintava: null,
        why: `already ${e.status}`,
      };
    }
    if (e.discrepancy) {
      return {
        outcome: 'disagrees',
        status: e.status,
        decision: null,
        fintava: null,
        why: 'a disagreement with Fintava is recorded; left for review',
      };
    }
    if (this.fintava.environment === 'unconfigured') {
      return this.waiting(e, null, 'not_configured');
    }

    // One of our sends, named by our reference: Fintava's status endpoint as
    // MONEY-06 reads it (lookup, then the sender's history), and its rules.
    // Not a bill: Fintava's bill calls take no reference of ours, so its
    // absence there would prove nothing.
    const ourSend =
      e.direction === 'out' &&
      !!e.customerReference &&
      e.category !== 'bill' &&
      e.counterpartyKind !== 'biller';
    const sender = ourSend ? await this.senderOf(e) : null;
    if (sender && e.customerReference) {
      const reconciliation = await this.reconcile(
        e,
        e.customerReference,
        sender,
      );
      const decision = decideFintavaRetry(this.kindOf(e), reconciliation, {
        attemptedAt: this.attemptedAt(e),
        now,
        resendAfterMs:
          this.fintava.settings.moneyTimeoutMs +
          this.fintava.settings.resendSafetyMs,
      });
      const answered = reconciliation.state;
      if (reconciliation.state === 'found') {
        return {
          ...(await this.apply(
            e,
            reconciliation.transaction,
            reconciliation.source,
            decision,
          )),
          fintava: answered,
        };
      }
      if (
        decision.action === 'resend_same_reference' ||
        (decision.action === 'resend_new_reference' &&
          decision.why === 'absent')
      ) {
        const changed = await this.ledger.markAbsentFailed(e.id);
        if (!changed) {
          return {
            ...(await this.reread(e.id, decision, 'changed meanwhile')),
            fintava: answered,
          };
        }
        return {
          outcome: 'failed_absent',
          status: 'failed',
          decision,
          fintava: answered,
          why: 'no record at Fintava',
        };
      }
      return {
        ...this.waiting(
          e,
          decision,
          decision.action === 'wait' ? decision.why : decision.action,
        ),
        fintava: answered,
      };
    }

    // Anything else (money in, a send recorded without our reference, a
    // bill): its own references, by lookup. A reference that is not ours
    // being unknown to Fintava proves nothing, so this never fails a row.
    const looked = await this.lookUp(e);
    if (looked.transaction) {
      return {
        ...(await this.apply(e, looked.transaction, 'lookup', null)),
        fintava: 'found',
      };
    }
    return {
      ...this.waiting(e, null, looked.why),
      fintava:
        looked.why === 'not found'
          ? 'absent'
          : looked.why === 'nothing to ask by'
            ? null
            : 'unknown',
    };
  }

  /** Settles the row from Fintava's record, or records why it cannot. */
  private async apply(
    e: Entry,
    t: FintavaTransaction,
    source: 'lookup' | 'history',
    decision: FintavaRetryDecision | null,
  ): Promise<LedgerStatusCheck> {
    const stored = koboNumber(e.amountKobo);
    if (t.amountKobo !== stored) {
      // A stop: never settle a row whose figure Fintava does not confirm.
      await this.ledger.noteDiscrepancy(
        e.id,
        `status check: amountKobo ${stored} vs ${t.amountKobo}`,
      );
      this.logger.error(
        `ledger status: Fintava's record of row ${e.id} has another amount; the row is left pending for review`,
      );
      return {
        outcome: 'disagrees',
        status: 'pending',
        decision,
        fintava: 'found',
        why: 'amount differs from Fintava',
      };
    }
    const status = ledgerStatusOf(t.status) ?? 'pending';
    const out = e.direction === 'out';
    const tagapay = t.tagapayTransRef ?? (await this.tagapayOf(t));
    await this.ledger.record({
      wallet: this.walletOf(e),
      direction: e.direction,
      status,
      category: e.category,
      amountKobo: t.amountKobo,
      // Lookups and history carry no fee for a wallet-to-wallet send: the
      // row's own fee and total stand, and only the amount is compared.
      feeKobo: koboNumber(e.feeKobo),
      totalKobo: koboNumber(e.totalKobo),
      references: {
        customerReference: out ? t.customerReference : null,
        fintavaReference: t.fintavaReference,
        tagapayTransRef: tagapay,
        fintavaTransactionId: t.id,
        sessionId: t.sessionId,
        // On a receiving side, the sender's reference is only another one.
        delivery: out ? [] : [t.customerReference],
      },
      failureReason: status === 'failed' ? LEDGER_FINTAVA_FAILURE : null,
      source,
      occurredAt: Number.isNaN(Date.parse(t.createdAt))
        ? null
        : new Date(t.createdAt),
    });
    if (status === 'pending') {
      return this.waiting(e, decision, 'pending at Fintava');
    }
    return this.reread(
      e.id,
      decision,
      `Fintava says ${t.status.toUpperCase()}`,
    );
  }

  private async reread(
    entryId: string,
    decision: FintavaRetryDecision | null,
    why: string,
  ): Promise<LedgerStatusCheck> {
    const row = await this.prisma.fintavaLedgerEntry.findUnique({
      where: { id: entryId },
      select: { status: true, discrepancy: true },
    });
    if (!row) {
      return { outcome: 'skipped', status: null, decision, fintava: null, why };
    }
    if (row.status === 'pending') {
      return {
        outcome: row.discrepancy ? 'disagrees' : 'waiting',
        status: row.status,
        decision,
        fintava: null,
        why,
      };
    }
    return {
      outcome: 'settled',
      status: row.status,
      decision,
      fintava: null,
      why,
    };
  }

  private waiting(
    e: Entry,
    decision: FintavaRetryDecision | null,
    why: string,
  ): LedgerStatusCheck {
    return {
      outcome: 'waiting',
      status: e.status,
      decision,
      fintava: null,
      why,
    };
  }

  /** MONEY-06's reconcile; a Fintava error of any kind is an unknown answer. */
  private async reconcile(
    e: Entry,
    reference: string,
    sender: FintavaSender,
  ): Promise<FintavaReconciliation> {
    const since =
      e.occurredAt.getTime() < e.createdAt.getTime()
        ? e.occurredAt
        : e.createdAt;
    try {
      return await this.fintava.reconcile(reference, sender, since);
    } catch (err) {
      if (err instanceof FintavaError) {
        return { state: 'unknown', why: 'unreachable' };
      }
      throw err;
    }
  }

  /** The row's own findable references, by lookup, then its transaction id. */
  private async lookUp(
    e: Entry,
  ): Promise<{ transaction: FintavaTransaction | null; why: string }> {
    const held = await this.prisma.fintavaLedgerReference.findMany({
      where: { entryId: e.id, kind: { in: ['ours', 'fintava', 'delivery'] } },
      select: { value: true },
      orderBy: { value: 'asc' },
    });
    const refs = [
      ...new Set(
        [e.customerReference, e.fintavaReference, ...held.map((h) => h.value)]
          .filter((v): v is string => !!v)
          .filter((v) => !v.startsWith('sha256:')),
      ),
    ].slice(0, LEDGER_STATUS_DEFAULTS.lookups);
    let why =
      refs.length || e.fintavaTransactionId ? 'not found' : 'nothing to ask by';
    for (const ref of refs) {
      try {
        const l = await this.fintava.getTransactionByReference(ref);
        if (l.state === 'found')
          return { transaction: l.transaction, why: 'found' };
        if (l.state === 'unknown') why = 'empty_lookup';
      } catch (err) {
        if (!(err instanceof FintavaError)) throw err;
        why = 'unreachable';
      }
    }
    if (e.fintavaTransactionId) {
      try {
        const l = await this.fintava.getTransactionById(e.fintavaTransactionId);
        if (l.state === 'found')
          return { transaction: l.transaction, why: 'found' };
        if (l.state === 'unknown') why = 'empty_lookup';
      } catch (err) {
        if (!(err instanceof FintavaError)) throw err;
        why = 'unreachable';
      }
    }
    return { transaction: null, why };
  }

  /** Whose history holds the row's debit: WAWU's, or the person's customerId. */
  private async senderOf(e: Entry): Promise<FintavaSender | null> {
    if (e.walletKind === 'merchant') return { kind: 'merchant' };
    if (!e.wawuUserId) return null;
    const w = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: e.wawuUserId },
      select: { customerId: true, accountNumber: true },
    });
    // The wallet must be the one the row is on.
    if (!w || w.accountNumber !== e.accountNumber) return null;
    return { kind: 'customer', customerId: w.customerId };
  }

  private walletOf(e: Entry): LedgerWallet {
    return e.walletKind === 'merchant' || !e.wawuUserId
      ? { kind: 'merchant', accountNumber: e.accountNumber }
      : {
          kind: 'user',
          wawuUserId: e.wawuUserId,
          accountNumber: e.accountNumber,
        };
  }

  /** A send to a bank account is a bank send; anything else moved between wallets. */
  private kindOf(e: Entry): FintavaSendKind {
    return e.counterpartyKind === 'bank_account'
      ? 'bank_transfer'
      : 'wallet_to_wallet';
  }

  /**
   * When the send was last attempted, for the resend window: the latest of
   * when the row was recorded, when the money is said to have moved, and
   * when the row last changed (a resend under the same reference touches
   * it). Later is safer: it only makes the window longer.
   */
  private attemptedAt(e: Entry): Date {
    return new Date(
      Math.max(
        e.createdAt.getTime(),
        e.occurredAt.getTime(),
        e.updatedAt.getTime(),
      ),
    );
  }

  /** The by-id record's tagapayTransRef: the only record that carries it. */
  private async tagapayOf(t: FintavaTransaction): Promise<string | null> {
    try {
      const l = await this.fintava.getTransactionById(t.id);
      return l.state === 'found' ? l.transaction.tagapayTransRef : null;
    } catch (err) {
      if (err instanceof FintavaError) return null;
      throw err;
    }
  }

  /** 1, 2, 4 ... minutes, at most an hour, between checks of a row left pending. */
  private backOff(entryId: string, now: Date): void {
    const prev = this.retryAt.get(entryId);
    const delayMs = Math.min(prev ? prev.delayMs * 2 : MINUTE, 60 * MINUTE);
    this.retryAt.set(entryId, { at: now.getTime() + delayMs, delayMs });
  }
}
