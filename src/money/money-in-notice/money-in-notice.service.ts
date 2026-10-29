import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import type { NoticeData } from '../../notice-mail/notice-kinds';
import { noticeKey, NoticeMailer } from '../../notice-mail/notice-mailer';
import { rowsOf } from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
  type WalletProviderName,
} from '../../wallet-provider/wallet-provider.interface';
import {
  MONEY_IN_CATEGORIES,
  MONEY_IN_NOTICE_CONFIG_KEYS,
  MONEY_IN_NOTICE_DEFAULTS,
  moneyInNoticeWindowMs,
} from './money-in-notice-config';
import { creditSourceOf } from './money-in-sources';

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

/** What one pass over one told credit that the ledger has since reversed did. */
export type MoneyInCorrectionOutcome =
  /** A `money_in_reversed` notification was written, with the mark, in one transaction. */
  | 'corrected'
  /** Not eligible any more, locked by a writer, or another process took it. */
  | 'skipped'
  /** Nothing was written; tried again. */
  | 'failed';

export type MoneyInCorrectionReport = Record<MoneyInCorrectionOutcome, number>;

/** The notification could not be written for a reason that is not the switch. */
class NoticeNotWritten extends Error {
  constructor() {
    super('money in: the notification was not written');
    this.name = 'NoticeNotWritten';
  }
}

const MINUTE = 60_000;

/** What the email of one told credit is made from, held until its transaction commits. */
interface MoneyInMail {
  wawuId: string;
  data: NoticeData['money_in'];
}

/**
 * The ledger rows that are money in, told or not: an `in` row of a money-in
 * category (`MONEY_IN_CATEGORIES`: a bank transfer in, money from another
 * person, earnings, a refund; R-54) on a person's wallet, completed, with no
 * disagreement recorded on it, of the provider this server runs (R-39: a
 * server acts only on its own provider's rows), that has no mark yet. One
 * definition, read by the sweep and again under the row's lock before
 * anything is written.
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
    category: { in: [...MONEY_IN_CATEGORIES] },
    walletKind: 'user',
    status: 'completed',
    wawuUserId: { not: null },
    discrepancy: null,
    AND: [rowsOf(provider)],
    moneyInNotice: null,
  };
}

/**
 * The credits a person was told about and the ledger has since reversed, that
 * have no correction yet (WALLET-39). A credit nobody was told about (`muted`,
 * `before`, or never marked) has nothing to correct. A recorded disagreement
 * does not hold a correction back: the row is reversed, which the ledger
 * never takes back, and the notice that stands says otherwise.
 */
export function reversedCredits(
  provider: WalletProviderName,
): Prisma.FintavaLedgerEntryWhereInput {
  return {
    direction: 'in',
    category: { in: [...MONEY_IN_CATEGORIES] },
    walletKind: 'user',
    status: 'reversed',
    wawuUserId: { not: null },
    AND: [rowsOf(provider)],
    moneyInNotice: { is: { outcome: 'sent', correctedAt: null } },
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
 * twice (BACKEND_GAPS G-730). WALLET-39: it is corrected instead. When the
 * ledger row of a credit that was told (`sent`) goes `reversed`, one
 * `money_in_reversed` notification follows, written with the mark's
 * `correctedAt` in one transaction under the same lock, so a reversal is
 * corrected once. A credit nobody was told about is not corrected.
 *
 * WALLET-39 (R-54): every credit to a person's wallet is told, not only a bank
 * transfer: money from another person, earnings landing, a refund. The unit
 * is still one ledger row, so whatever writes an `in` row of a money-in
 * category (WALLET-16's settlement, a released or refunded hold, a book
 * transfer) is covered with no hook of its own. Each notice carries the row's
 * id as its `transaction` target, which the phone push repeats in `data`:
 * the app opens `GET /money/transactions/{id}` (the receipt, or W46 for a
 * bank transfer in).
 */
@Injectable()
export class MoneyInNoticeService {
  private readonly logger = new Logger(MoneyInNoticeService.name);
  private readonly windowMs: number;
  private sweeping = false;
  private correcting = false;
  /** Rows that failed, and when each may be tried again (per process). */
  private readonly retryAt = new Map<string, { at: number; delayMs: number }>();
  /** The same for corrections. */
  private readonly correctRetryAt = new Map<
    string,
    { at: number; delayMs: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly notifications: NotificationService,
    config: ConfigService,
    /** Optional so the specs that build this by hand need no mailer; the module always provides it. */
    @Optional() private readonly mail?: NoticeMailer,
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
    try {
      const fixed = await this.sweepCorrections();
      if (fixed.corrected + fixed.failed > 0) {
        this.logger.log(
          `money in: ${fixed.corrected} corrected, ${fixed.failed} failed`,
        );
      }
    } catch (e) {
      this.logger.error(
        `money in: a correction pass failed (${e instanceof Error ? e.name : 'Error'})`,
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
      const emailed: { facts: MoneyInMail | null } = { facts: null };
      const outcome = await this.prisma.$transaction(
        (tx) => this.tell(tx, entryId, emailed),
        { maxWait: 5_000, timeout: 15_000 },
      );
      this.retryAt.delete(entryId);
      // EMAIL-02: after the notice and its mark are committed, so a row told
      // twice (two sightings, two servers) is one email, and a rolled-back
      // pass sends none. The mark makes the notice once; the key makes the
      // email once.
      if (outcome === 'sent' && emailed.facts !== null) {
        this.mail?.notify(
          emailed.facts.wawuId,
          'money_in',
          emailed.facts.data,
          noticeKey('money_in', entryId),
        );
      }
      return outcome;
    } catch (e) {
      // The key was taken between the read and the write: another process
      // told it, and this transaction (the notification with it) is undone.
      if ((e as { code?: unknown } | null)?.code === 'P2002') return 'skipped';
      // The name only: a message can quote what the row carried.
      this.logger.error(
        `money in: a credit could not be told (${e instanceof Error ? e.name : 'Error'}); it is tried again`,
      );
      this.backOff(this.retryAt, entryId, now);
      return 'failed';
    }
  }

  private async tell(
    tx: Prisma.TransactionClient,
    entryId: string,
    emailed: { facts: MoneyInMail | null },
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
        category: true,
        linkKind: true,
        counterpartyKind: true,
        counterpartyName: true,
        counterpartyAccountNumber: true,
        counterpartyBankName: true,
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
          ...creditSourceOf(row),
          about: { target: { kind: 'transaction', id: entryId } },
        },
        tx,
      );
      if (written) {
        outcome = 'sent';
        notificationId = written.id;
        // Money from a bank or from another person is emailed; earnings,
        // refunds, swaps and points have their own emails or are the
        // person's own money moving (EMAIL-02, Default (lead)).
        const from = creditSourceOf(row);
        if (from.source === 'bank' || from.source === 'transfer') {
          emailed.facts = {
            wawuId: row.wawuUserId,
            data: {
              amountMinor: Number(row.amountKobo),
              currency: 'NGN',
              senderName: from.senderName,
            },
          };
        }
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

  /**
   * WALLET-39. One pass over the told credits the ledger has reversed since,
   * oldest first, each corrected once. One pass at a time per process; other
   * processes are kept out row by row (the lock, then the mark).
   */
  async sweepCorrections(now = new Date()): Promise<MoneyInCorrectionReport> {
    const report: MoneyInCorrectionReport = {
      corrected: 0,
      skipped: 0,
      failed: 0,
    };
    if (this.correcting) return report;
    this.correcting = true;
    try {
      const since = new Date(
        now.getTime() - MONEY_IN_NOTICE_DEFAULTS.correctionDays * 86_400_000,
      );
      const seen = new Set<string>(
        [...this.correctRetryAt.entries()]
          .filter(([, r]) => r.at > now.getTime())
          .map(([id]) => id),
      );
      for (let pass = 0; pass < MONEY_IN_NOTICE_DEFAULTS.passes; pass += 1) {
        const due = await this.prisma.fintavaLedgerEntry.findMany({
          where: {
            ...reversedCredits(this.provider.name),
            occurredAt: { gte: since },
            ...(seen.size > 0 ? { id: { notIn: [...seen] } } : {}),
          },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: MONEY_IN_NOTICE_DEFAULTS.batch,
          select: { id: true },
        });
        for (const { id } of due) {
          seen.add(id);
          report[await this.correctEntry(id, now)] += 1;
        }
        if (due.length < MONEY_IN_NOTICE_DEFAULTS.batch) break;
      }
      return report;
    } finally {
      this.correcting = false;
    }
  }

  /** One ledger row, by id: corrects it if it was told and is now reversed. */
  async correctEntry(
    entryId: string,
    now = new Date(),
  ): Promise<MoneyInCorrectionOutcome> {
    try {
      const outcome = await this.prisma.$transaction(
        (tx) => this.correct(tx, entryId, now),
        { maxWait: 5_000, timeout: 15_000 },
      );
      this.correctRetryAt.delete(entryId);
      return outcome;
    } catch (e) {
      // The name only: a message can quote what the row carried.
      this.logger.error(
        `money in: a reversed credit could not be corrected (${e instanceof Error ? e.name : 'Error'}); it is tried again`,
      );
      this.backOff(this.correctRetryAt, entryId, now);
      return 'failed';
    }
  }

  private async correct(
    tx: Prisma.TransactionClient,
    entryId: string,
    now: Date,
  ): Promise<'corrected' | 'skipped'> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "FintavaLedgerEntry"
       WHERE "id" = ${entryId}
       FOR NO KEY UPDATE SKIP LOCKED`;
    if (locked.length === 0) return 'skipped';
    const row = await tx.fintavaLedgerEntry.findFirst({
      where: { id: entryId, ...reversedCredits(this.provider.name) },
      select: {
        wawuUserId: true,
        amountKobo: true,
        category: true,
        linkKind: true,
        counterpartyKind: true,
        counterpartyName: true,
        counterpartyAccountNumber: true,
        counterpartyBankName: true,
      },
    });
    if (!row || row.wawuUserId === null) return 'skipped';
    // No switch is read here: the list always carries the correction of a
    // notice that stands in it. "Money in" mutes the phone push only
    // (PUSH_ONLY_GATE).
    const written = await this.notifications.emit(
      {
        kind: 'money_in_reversed',
        userWawuId: row.wawuUserId,
        amountKobo: row.amountKobo,
        ...creditSourceOf(row),
        about: { target: { kind: 'transaction', id: entryId } },
      },
      tx,
    );
    if (!written) throw new NoticeNotWritten();
    const marked = await tx.moneyInNotice.updateMany({
      where: { entryId, outcome: 'sent', correctedAt: null },
      data: { correctedAt: now, correctionNotificationId: written.id },
    });
    // The lock and the read above say this is one row: anything else undoes
    // the notification with it.
    if (marked.count !== 1) throw new NoticeNotWritten();
    return 'corrected';
  }

  /** 1, 2, 4 ... minutes, at most an hour, before a row that failed is tried again. */
  private backOff(
    rests: Map<string, { at: number; delayMs: number }>,
    entryId: string,
    now: Date,
  ): void {
    const prev = rests.get(entryId);
    const delayMs = Math.min(
      prev ? prev.delayMs * 2 : MINUTE,
      MONEY_IN_NOTICE_DEFAULTS.maxRestMinutes * MINUTE,
    );
    rests.set(entryId, { at: now.getTime() + delayMs, delayMs });
  }
}
