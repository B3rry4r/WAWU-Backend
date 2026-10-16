import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { rowsOf } from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
  type WalletProviderName,
} from '../../wallet-provider/wallet-provider.interface';
import {
  MONEY_IN_NOTICE_CONFIG_KEYS,
  MONEY_IN_NOTICE_DEFAULTS,
  moneyInNoticeWindowMs,
} from './money-in-notice-config';

/** What one pass over one credited ledger row did. */
export type MoneyInNoticeOutcome =
  /** A `money_in` notification was written, with its mark, in one transaction. */
  | 'sent'
  /** The person's "Money in" switch was off: only the mark was written. */
  | 'muted'
  /** Not eligible any more, locked by a writer, or another process took it. */
  | 'skipped'
  /** Nothing was written (an error, or the notification could not be written); tried again. */
  | 'failed';

export type MoneyInSweepReport = Record<MoneyInNoticeOutcome, number>;

/** The notification could not be written for a reason that is not the switch. */
class NoticeNotWritten extends Error {
  constructor() {
    super('money in: the notification was not written');
    this.name = 'NoticeNotWritten';
  }
}

const MINUTE = 60_000;

/**
 * The ledger rows that are money in, told or not: an `in` row of category
 * `top_up` on a person's wallet, completed, with no disagreement recorded on
 * it, of the provider this server runs (R-39: a server acts only on its own
 * provider's rows), that has no mark yet. One definition, read by the sweep
 * and again under the row's lock before anything is written.
 *
 * A row with a disagreement (`discrepancy`) is a stop for review (WORKFLOW
 * section 10): the amount in the text could be wrong, so nothing is said until
 * a person has looked. The history shows the row either way.
 */
export function creditedRows(
  provider: WalletProviderName,
): Prisma.FintavaLedgerEntryWhereInput {
  return {
    direction: 'in',
    category: 'top_up',
    walletKind: 'user',
    status: 'completed',
    wawuUserId: { not: null },
    discrepancy: null,
    AND: [rowsOf(provider)],
    moneyInNotice: null,
  };
}

/**
 * Money in, told once (task WALLET-10, BACKEND_GAPS G-33).
 *
 * Notified from the LEDGER, never from the webhook event: the event table has
 * one `processingStatus` for every consumer, and the ledger marks an
 * `account_funded` delivery processed once it is a ledger row. Both providers
 * write the same rows (Fintava's `account_funded` through the ledger sweep,
 * Nuvion's `inflows.completed` through NUV-04's handler): an `in` row of
 * category `top_up`, stamped with its provider. This sweep reads the rows of
 * the provider the server runs and nothing else, and never calls a provider.
 *
 * Exactly once, whatever happens to the delivery, the row or the process:
 *  - the unit is one ledger row, so a replayed delivery, two deliveries of
 *    one credit in any order, and a row seen by two sightings are one row
 *    (the ledger folds them, MONEY-10) and one notification;
 *  - the notification and this task's mark (`MoneyInNotice`, primary key the
 *    ledger row) are written in ONE transaction, with the ledger row locked
 *    (`FOR NO KEY UPDATE SKIP LOCKED`), so two Hub processes never both tell
 *    it, and a stop between the two writes undoes both: the next pass does
 *    them again. If the primary key were ever hit, the transaction (the
 *    notification with it) rolls back;
 *  - the person's "Money in" switch (Z3) is read in that transaction. Off:
 *    only the mark is written, as `muted`. Nothing is queued: switching it
 *    on later does not bring the old credit back.
 *
 * The push is not sent here. A `money_in` notification is in the Notification
 * table, which the push sender reads (INBOX-03): it makes one delivery per
 * notification and phone, and checks the same switch again as it sends.
 *
 * A credit recalled after it was told is not told again: a row that is no
 * longer `completed` is never told, and a row already marked is never told
 * twice (BACKEND_GAPS G-730).
 */
@Injectable()
export class MoneyInNoticeService {
  private readonly logger = new Logger(MoneyInNoticeService.name);
  private readonly windowMs: number;
  private sweeping = false;
  /** Rows that failed, and when each may be tried again (per process). */
  private readonly retryAt = new Map<string, { at: number; delayMs: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly notifications: NotificationService,
    config: ConfigService,
  ) {
    this.windowMs = moneyInNoticeWindowMs(
      config.get<string>(MONEY_IN_NOTICE_CONFIG_KEYS.windowHours),
    );
  }

  /** The pass, in every Hub process. Failures are logged by name only. */
  @Interval('money-in-notices', MONEY_IN_NOTICE_DEFAULTS.sweepSeconds * 1000)
  async tick(): Promise<void> {
    try {
      const report = await this.sweep();
      if (report.sent + report.muted + report.failed > 0) {
        this.logger.log(
          `money in: ${report.sent} told, ${report.muted} muted, ${report.failed} failed`,
        );
      }
    } catch (e) {
      this.logger.error(
        `money in: a pass failed (${e instanceof Error ? e.name : 'Error'})`,
      );
    }
  }

  /**
   * One pass: the credits the Hub learned of inside the window that have no
   * mark, oldest first. One pass at a time per process; other processes are
   * kept out row by row (the lock, then the key).
   */
  async sweep(now = new Date()): Promise<MoneyInSweepReport> {
    const report: MoneyInSweepReport = {
      sent: 0,
      muted: 0,
      skipped: 0,
      failed: 0,
    };
    if (this.sweeping) return report;
    this.sweeping = true;
    try {
      const since = new Date(now.getTime() - this.windowMs);
      const seen = new Set<string>(
        [...this.retryAt.entries()]
          .filter(([, r]) => r.at > now.getTime())
          .map(([id]) => id),
      );
      for (let pass = 0; pass < MONEY_IN_NOTICE_DEFAULTS.passes; pass += 1) {
        const due = await this.prisma.fintavaLedgerEntry.findMany({
          where: {
            ...creditedRows(this.provider.name),
            createdAt: { gte: since },
            ...(seen.size > 0 ? { id: { notIn: [...seen] } } : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: MONEY_IN_NOTICE_DEFAULTS.batch,
          select: { id: true },
        });
        for (const { id } of due) {
          seen.add(id);
          report[await this.noticeEntry(id, now)] += 1;
        }
        if (due.length < MONEY_IN_NOTICE_DEFAULTS.batch) break;
      }
      return report;
    } finally {
      this.sweeping = false;
    }
  }

  /** One ledger row, by id: tells it if it is money in nobody was told of yet. */
  async noticeEntry(
    entryId: string,
    now = new Date(),
  ): Promise<MoneyInNoticeOutcome> {
    try {
      const outcome = await this.prisma.$transaction(
        (tx) => this.tell(tx, entryId),
        { maxWait: 5_000, timeout: 15_000 },
      );
      this.retryAt.delete(entryId);
      return outcome;
    } catch (e) {
      // The key was taken between the read and the write: another process
      // told it, and this transaction (the notification with it) is undone.
      if ((e as { code?: unknown } | null)?.code === 'P2002') return 'skipped';
      // The name only: a message can quote what the row carried.
      this.logger.error(
        `money in: a credit could not be told (${e instanceof Error ? e.name : 'Error'}); it is tried again`,
      );
      this.backOff(entryId, now);
      return 'failed';
    }
  }

  private async tell(
    tx: Prisma.TransactionClient,
    entryId: string,
  ): Promise<'sent' | 'muted' | 'skipped'> {
    // The row, locked. A writer holding it (a merge, a status check) is not
    // waited for: this row is read again on the next pass.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "FintavaLedgerEntry"
       WHERE "id" = ${entryId}
       FOR NO KEY UPDATE SKIP LOCKED`;
    if (locked.length === 0) return 'skipped';
    const row = await tx.fintavaLedgerEntry.findFirst({
      where: { id: entryId, ...creditedRows(this.provider.name) },
      select: {
        wawuUserId: true,
        amountKobo: true,
        counterpartyName: true,
        counterpartyAccountNumber: true,
      },
    });
    if (!row || row.wawuUserId === null) return 'skipped';

    let outcome: 'sent' | 'muted';
    let notificationId: string | null = null;
    if (await this.notifications.isSwitchOff(row.wawuUserId, 'moneyIn', tx)) {
      outcome = 'muted';
    } else {
      const written = await this.notifications.emit(
        {
          kind: 'money_in',
          userWawuId: row.wawuUserId,
          amountKobo: row.amountKobo,
          senderName: row.counterpartyName,
          senderAccountNumber: row.counterpartyAccountNumber,
        },
        tx,
      );
      if (written) {
        outcome = 'sent';
        notificationId = written.id;
      } else if (
        await this.notifications.isSwitchOff(row.wawuUserId, 'moneyIn', tx)
      ) {
        // Switched off between the two reads: muted, the same as above.
        outcome = 'muted';
      } else {
        throw new NoticeNotWritten();
      }
    }
    await tx.moneyInNotice.create({
      data: { entryId, outcome, notificationId },
    });
    return outcome;
  }

  /** 1, 2, 4 ... minutes, at most an hour, before a row that failed is tried again. */
  private backOff(entryId: string, now: Date): void {
    const prev = this.retryAt.get(entryId);
    const delayMs = Math.min(
      prev ? prev.delayMs * 2 : MINUTE,
      MONEY_IN_NOTICE_DEFAULTS.maxRestMinutes * MINUTE,
    );
    this.retryAt.set(entryId, { at: now.getTime() + delayMs, delayMs });
  }
}
