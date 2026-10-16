import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  DEFAULT_ROW_PROVIDER,
  isRowOf,
} from '../../wallet-provider/provider-rows';
import {
  type ProviderHolder,
  type ProviderReconciliation,
  type ProviderRetryDecision,
  type ProviderSendKind,
  type ProviderTransaction,
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
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
   * (the provider's `decideRetry`) allow its sender to do next. Advice only: this
   * service never sends money, and a resend is the sending feature's, under
   * its own lock on the payment (one retry at a time, MONEY-06).
   */
  decision: ProviderRetryDecision | null;
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
 * - Found PENDING or ONGOING, a lookup answering `{}`, a history walk cut
 *   off by its page limit, or Fintava out of reach: nothing changes; it is
 *   asked again later, backing off on a schedule kept on the row. An
 *   unknown outcome stays pending; it is never guessed.
 * - Fintava's own `404 "Transaction not found!"` for OUR reference and no
 *   row in a complete walk of the sender's history, once the resend window
 *   has passed (the only `absent` MONEY-06 accepts): the send never
 *   happened, so the row is failed with LEDGER_ABSENT_FAILURE (no money
 *   moved). Only if nothing about it changed while it was being checked
 *   and Fintava never told us about it (LedgerService.markAbsentFailed). A
 *   later sighting of that reference with the same figures undoes it, as a
 *   revival (`revivedAt`, `revivedBy`), and the sweep goes on asking.
 * - Fintava's record has another amount than the row: a stop. The
 *   disagreement is written on the row's `discrepancy`, the status is not
 *   moved, and the sweep leaves the row for review (MONEY-16).
 * - It never sends money: no resend, and no refund of a failed send.
 *   Fintava reverses a failed bank send itself (`debit_transfer_reversal`),
 *   which MONEY-10 applies as the row's `reversed` status; WAWU paying it
 *   back as well would pay it twice.
 * - It never adds anything up: the balance is Fintava's (MONEY-11).
 *
 * Every question goes through the wallet provider seam (MONEY-20): the
 * provider's `reconcileSend`, `decideRetry`, lookups and second reference.
 * Fintava's rules behind them are unchanged (src/fintava/).
 */
@Injectable()
export class LedgerStatusService {
  private readonly logger = new Logger(LedgerStatusService.name);
  private readonly checkAfterMs: number;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    config: ConfigService,
  ) {
    this.checkAfterMs = ledgerStatusCheckAfterMs(
      config.get<string>(LEDGER_CONFIG_KEYS.statusCheckAfterMinutes),
    );
  }

  /**
   * The pending sweep. Each pass claims up to LEDGER_STATUS_DEFAULTS.batch
   * `pending` rows that are due (their `nextCheckAt` has come; a row never
   * checked is due two minutes after it was recorded or revived) and holds
   * no disagreement, and asks Fintava about each.
   *
   * The schedule lives on the row (`nextCheckAt`, `statusChecks`), so a
   * restart, a deploy or a second server keeps it: claiming a row moves its
   * `nextCheckAt` on by the next rest (1, 2, 4 ... minutes, at most 60) in
   * the same statement, under `FOR UPDATE SKIP LOCKED`, so two servers never
   * claim the same row in the same minute and Fintava is asked about at most
   * `batch` rows per pass per server. A row that settles leaves the sweep;
   * one that does not is already scheduled.
   *
   * Only rows of the provider the server runs are claimed (NUV-01): after
   * a rollback, another provider's pending sends are never asked about
   * here, so they are never failed as absent by a provider that never had
   * them. They wait, untouched, for their own provider.
   *
   * Order: rows recorded (or revived) within the last hour first, then the
   * rest; within each, the earliest due first. A backlog that Fintava never
   * settles (the orphan PENDING record of a refused bank send, money in that
   * no history lists) is asked about at most hourly and never delays a fresh
   * transfer (MONEY-08 round 2, the verifier's backlog finding).
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
      const due = await this.claimDue(now);
      for (const id of due) {
        try {
          const c = await this.checkOnce(id, now);
          counts[c.outcome] += 1;
        } catch (e) {
          // The name only: a message can quote what Fintava sent. The row is
          // already scheduled by its claim.
          this.logger.error(
            `ledger status: a pending row could not be checked (${(e as Error).name ?? 'Error'}); it stays pending`,
          );
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
   * Claims the rows due at `now`, in the sweep's order, and moves each one's
   * `nextCheckAt` on by its next rest in the same statement. Never touches
   * `updatedAt`: the resend window reads it as "last attempted".
   */
  private async claimDue(now: Date): Promise<string[]> {
    const afterMs = this.checkAfterMs;
    const fresh = new Date(
      now.getTime() - LEDGER_STATUS_DEFAULTS.freshMinutes * MINUTE,
    );
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; fresh: boolean; dueAt: Date }>
    >`
      WITH due AS (
        SELECT "id",
               GREATEST("createdAt", COALESCE("revivedAt", "createdAt"))
                 > ${fresh}::timestamp(3) AS "fresh",
               COALESCE("nextCheckAt",
                        GREATEST("createdAt", COALESCE("revivedAt", "createdAt"))
                          + ${afterMs}::float8 * interval '1 millisecond') AS "dueAt"
          FROM "FintavaLedgerEntry"
         WHERE "status" = 'pending'
           AND "discrepancy" IS NULL
           AND COALESCE("provider", ${DEFAULT_ROW_PROVIDER}) = ${this.provider.name}
           AND COALESCE("nextCheckAt",
                        GREATEST("createdAt", COALESCE("revivedAt", "createdAt"))
                          + ${afterMs}::float8 * interval '1 millisecond')
                 <= ${now}::timestamp(3)
         ORDER BY 2 DESC, 3 ASC, "id" ASC
         LIMIT ${LEDGER_STATUS_DEFAULTS.batch}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "FintavaLedgerEntry" AS e
         SET "statusChecks" = e."statusChecks" + 1,
             "nextCheckAt" = ${now}::timestamp(3)
               + LEAST(${LEDGER_STATUS_DEFAULTS.maxRestMinutes}::int,
                       power(2, LEAST(e."statusChecks", 12))::int)
                 * interval '1 minute'
        FROM due
       WHERE e."id" = due."id"
      RETURNING due."id", due."fresh", due."dueAt"`;
    return rows
      .sort(
        (a, b) =>
          Number(b.fresh) - Number(a.fresh) ||
          a.dueAt.getTime() - b.dueAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((r) => r.id);
  }

  /**
   * Asks Fintava how one `pending` ledger row ended and settles it if
   * Fintava knows. The sweep calls it; so may a sending feature before it
   * decides to retry (WALLET-09), using the returned decision. When it
   * cannot settle the row, the row's next check is scheduled as a sweep's
   * would be, so a direct check also counts towards the rest.
   */
  async check(entryId: string, now = new Date()): Promise<LedgerStatusCheck> {
    const result = await this.checkOnce(entryId, now);
    if (result.outcome === 'waiting') await this.reschedule(entryId, now);
    return result;
  }

  /** The next rest for a row left pending, as a claim sets it. */
  private async reschedule(entryId: string, now: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "FintavaLedgerEntry"
         SET "statusChecks" = "statusChecks" + 1,
             "nextCheckAt" = ${now}::timestamp(3)
               + LEAST(${LEDGER_STATUS_DEFAULTS.maxRestMinutes}::int,
                       power(2, LEAST("statusChecks", 12))::int)
                 * interval '1 minute'
       WHERE "id" = ${entryId} AND "status" = 'pending'`;
  }

  private async checkOnce(
    entryId: string,
    now: Date,
  ): Promise<LedgerStatusCheck> {
    // The row's version as this check starts (Postgres `xmin`, which every
    // write to the row changes): an absent verdict is only written if the
    // row is still this version (LedgerService.markAbsentFailed).
    const version = await this.prisma.$queryRaw<Array<{ v: string }>>`
      SELECT xmin::text AS "v" FROM "FintavaLedgerEntry" WHERE "id" = ${entryId}`;
    const e = await this.prisma.fintavaLedgerEntry.findUnique({
      where: { id: entryId },
    });
    if (!e || version.length === 0) {
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
    // Another provider's row (NUV-01): never asked about here, never moved.
    if (!isRowOf(this.provider.name, e.provider)) {
      return {
        outcome: 'skipped',
        status: e.status,
        decision: null,
        fintava: null,
        why: `recorded by another provider than ${this.provider.label}`,
      };
    }
    if (e.discrepancy) {
      return {
        outcome: 'disagrees',
        status: e.status,
        decision: null,
        fintava: null,
        why: `a disagreement with ${this.provider.label} is recorded; left for review`,
      };
    }
    if (!this.provider.configured) {
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
      const timings = this.provider.timings;
      const decision = this.provider.decideRetry(
        this.kindOf(e),
        reconciliation,
        {
          attemptedAt: this.attemptedAt(e),
          now,
          resendAfterMs: timings.moneyTimeoutMs + timings.resendSafetyMs,
        },
      );
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
        const changed = await this.ledger.markAbsentFailed(e.id, version[0].v);
        if (!changed) {
          // Something happened to the row, or a delivery for one of its
          // references exists: Fintava has told us about it, so it is not
          // absent. It stays as it is now and is asked about again; MONEY-06's
          // resend advice no longer stands.
          return {
            ...(await this.reread(
              e.id,
              { action: 'wait', why: 'pending' },
              'seen meanwhile, so not absent',
            )),
            fintava: answered,
          };
        }
        return {
          outcome: 'failed_absent',
          status: 'failed',
          decision,
          fintava: answered,
          why: `no record at ${this.provider.label}`,
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
    t: ProviderTransaction,
    source: 'lookup' | 'history',
    decision: ProviderRetryDecision | null,
  ): Promise<LedgerStatusCheck> {
    const stored = koboNumber(e.amountKobo);
    if (t.amountKobo !== e.amountKobo) {
      // A stop: never settle a row whose figure Fintava does not confirm.
      await this.ledger.noteDiscrepancy(
        e.id,
        `status check: amountKobo ${stored} vs ${t.amountKobo}`,
      );
      this.logger.error(
        `ledger status: ${this.provider.label}'s record of row ${e.id} has another amount; the row is left pending for review`,
      );
      return {
        outcome: 'disagrees',
        status: 'pending',
        decision,
        fintava: 'found',
        why: `amount differs from ${this.provider.label}`,
      };
    }
    const status = t.outcome ?? 'pending';
    const out = e.direction === 'out';
    const debitFee =
      out &&
      status === 'completed' &&
      e.walletKind === 'user' &&
      e.paymentId !== null &&
      t.feeKobo !== undefined &&
      t.feeKobo !== null
        ? safeKoboNumber(t.feeKobo)
        : null;
    const tagapay =
      t.secondaryReference ?? (await this.provider.secondaryReferenceOf(t));
    await this.ledger.record({
      wallet: this.walletOf(e),
      direction: e.direction,
      status,
      category: e.category,
      amountKobo: safeKoboNumber(t.amountKobo),
      // Lookups and history carry no fee for a Fintava wallet-to-wallet send:
      // the row's own fee and total stand, and only the amount is compared.
      // The exception is a payment's debit row, once the provider says it
      // completed, when the record DOES carry the provider's charge
      // (Nuvion's `applicable_fee`; MONEY-17 round 7,
      // lead ruling R6-1): that figure is compared, so a charge other than
      // the quote is a disagreement the ledger keeps as a stop (the payment
      // settles it from the same record), never a row completed at the quote.
      feeKobo: debitFee === null ? koboNumber(e.feeKobo) : debitFee,
      totalKobo:
        debitFee === null
          ? koboNumber(e.totalKobo)
          : safeKoboNumber(t.amountKobo) + debitFee,
      // No charge in the record: whatever the row holds when this lands
      // stands (read under its lock), not the figures read before the
      // lookup. A signed report of the real charge, or the payment's own
      // completion at it, may have changed them meanwhile (MONEY-17 round 8).
      figuresStand: debitFee === null,
      references: {
        customerReference: out ? t.ourReference : null,
        fintavaReference: t.providerReference,
        tagapayTransRef: tagapay,
        fintavaTransactionId: t.id,
        sessionId: t.sessionId,
        // On a receiving side, the sender's reference is only another one.
        delivery: out ? [] : [t.ourReference],
      },
      failureReason: status === 'failed' ? LEDGER_FINTAVA_FAILURE : null,
      source,
      occurredAt: Number.isNaN(Date.parse(t.createdAt))
        ? null
        : new Date(t.createdAt),
    });
    if (status === 'pending') {
      return this.waiting(e, decision, `pending at ${this.provider.label}`);
    }
    return this.reread(
      e.id,
      decision,
      `${this.provider.label} says ${t.status.toUpperCase()}`,
    );
  }

  private async reread(
    entryId: string,
    decision: ProviderRetryDecision | null,
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
    decision: ProviderRetryDecision | null,
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

  /** MONEY-06's reconcile; a provider error of any kind is an unknown answer. */
  private async reconcile(
    e: Entry,
    reference: string,
    sender: ProviderHolder,
  ): Promise<ProviderReconciliation> {
    const since =
      e.occurredAt.getTime() < e.createdAt.getTime()
        ? e.occurredAt
        : e.createdAt;
    try {
      return await this.provider.reconcileSend(reference, sender, since);
    } catch (err) {
      if (err instanceof WalletProviderError) {
        return { state: 'unknown', why: 'unreachable' };
      }
      throw err;
    }
  }

  /** The row's own findable references, by lookup, then its transaction id. */
  private async lookUp(
    e: Entry,
  ): Promise<{ transaction: ProviderTransaction | null; why: string }> {
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
        const l = await this.provider.findTransactionByReference(ref);
        if (l.state === 'found')
          return { transaction: l.transaction, why: 'found' };
        if (l.state === 'unknown') why = 'empty_lookup';
      } catch (err) {
        if (!(err instanceof WalletProviderError)) throw err;
        why = 'unreachable';
      }
    }
    if (e.fintavaTransactionId) {
      try {
        const l = await this.provider.findTransactionById(
          e.fintavaTransactionId,
        );
        if (l.state === 'found')
          return { transaction: l.transaction, why: 'found' };
        if (l.state === 'unknown') why = 'empty_lookup';
      } catch (err) {
        if (!(err instanceof WalletProviderError)) throw err;
        why = 'unreachable';
      }
    }
    return { transaction: null, why };
  }

  /** Whose history holds the row's debit: WAWU's, or the person's customerId. */
  private async senderOf(e: Entry): Promise<ProviderHolder | null> {
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
  private kindOf(e: Entry): ProviderSendKind {
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
}
