import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { DELETED_CREATOR_ID } from '../content-piece/deleted-creator';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { StorageRemover } from '../storage/storage-remover';
import {
  ID_DOCS_ACCOUNT_PAGE,
  ID_DOCS_CLAIM_MS,
  ID_DOCS_FILE_PAGE,
  ID_DOCS_KEEP_DAYS_SETTING,
  ID_DOCS_RETENTION_CRON,
  ID_DOCS_RETENTION_NAME,
  ID_DOCS_RUN_BUDGET_MS,
} from './id-docs-retention.config';
import { listKeptFiles } from './purge-files';

const DAY_MS = 86_400_000;

/** Why a run did nothing at all, or null when it ran. */
export type IdDocsSkip =
  'already_running' | 'setting_unreadable' | 'no_bucket' | null;

/** What one run did. Counts only: no id, no name, no key. */
export interface IdDocsRetentionReport {
  /** Set when the run did nothing. */
  skipped: IdDocsSkip;
  /** The days kept, as the admin setting held them at the start of the run. */
  days: number;
  /** Deletions completed before this were due. */
  cutoff: Date;
  /** Accounts the run held and worked on. */
  accountsWorked: number;
  /** Of those, accounts with no set-aside document left: their audit line is written. */
  accountsFinished: number;
  /** Of those, accounts left for the next run (a file the bucket refused, the time budget, an error). */
  accountsLeft: number;
  /** Due accounts another server held at that moment. */
  accountsHeldByOthers: number;
  /** Files deleted by this run (object removed, then row deleted). */
  filesErased: number;
  /** True when the time budget ended the run before it ran out of accounts. */
  stoppedEarly: boolean;
}

/** How one run is bounded. A spec passes smaller ones. */
export interface IdDocsRetentionLimits {
  budgetMs: number;
  accountPage: number;
  filePage: number;
  claimMs: number;
}

const DEFAULT_LIMITS: IdDocsRetentionLimits = {
  budgetMs: ID_DOCS_RUN_BUDGET_MS,
  accountPage: ID_DOCS_ACCOUNT_PAGE,
  filePage: ID_DOCS_FILE_PAGE,
  claimMs: ID_DOCS_CLAIM_MS,
};

type AccountOutcome = { erased: number; finished: boolean };

/**
 * Deletes a deleted account's set-aside ID documents once they have been kept
 * long enough (SETTINGS-09, R-73).
 *
 * WHICH ACCOUNTS. A deletion row that is `purged` (the Hub's data is gone and
 * WAWU ID has anonymised) whose `purgedAt` is more than `id_docs_keep_days`
 * days ago (an admin setting, 1826 at launch, read at the start of every run
 * after a fresh load, so a change applies at the next run; if the settings
 * cannot be read the run does nothing, never guesses a shorter period) and
 * that has no `idDocsErasedAt` yet. An account that is not `purged` is never
 * looked at: a live account, a scheduled or cancelled deletion and one still
 * being purged keep every file.
 *
 * WHICH FILES. `listKeptFiles(...).owner`: the `StorageObject` rows filed under
 * `deleted-account` whose key names this person, less the files a kept piece
 * names (kept for its buyers), the content folders and the event images kept
 * while an event stands. That is the very list the account's purge note
 * counted, so nothing else of the deleted account is touched. A live person's
 * rows carry their own id and are never selected.
 *
 * WHAT GOES. The object leaves the bucket first, and its row (the list of what
 * is in the bucket) only after the object is gone. The rows are deleted, not
 * blanked: nothing reads them (the rows that named the files went with the
 * purge), `key` is unique and non-null, and the record that matters is the
 * account's own audit line below.
 *
 * AUDIT. One line per account, on its deletion row: `idDocsErasedAt` (when it
 * finished), `idDocsErased` (files deleted) and `idDocsKeepDays` (the days
 * kept in force). Counts only: no name, no key, no number. The log line says
 * the same. An account with no file gets the line too (0 files), so it is
 * never looked at again.
 *
 * SAFE TO REPEAT. A second run, or a second server, finds `idDocsErasedAt` set
 * and does nothing. Two servers at once: a server takes an account with a
 * claim (`idDocsClaimedUntil`, a column, never a database lock held over the
 * bucket calls); the other leaves it. A crash frees the claim when it runs
 * out, and the next run finds the rest, because the rows are the inventory:
 * an object removed whose row was not yet deleted is found again, the bucket
 * answers "gone", and the row is deleted then. A file the bucket refuses keeps
 * its row, the others go, and the account is tried again next run.
 *
 * NETWORK. Every call to the bucket is made with no transaction open and no
 * lock held; the short transaction that deletes rows and counts them makes no
 * network call.
 *
 * `@Cron` runs only where ScheduleModule.forRoot() is loaded (AppModule); a
 * spec calls `run` with a chosen `now`.
 */
@Injectable()
export class IdDocsRetentionService {
  private readonly logger = new Logger(IdDocsRetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    @Optional() private readonly remover?: StorageRemover,
  ) {}

  @Cron(ID_DOCS_RETENTION_CRON, { name: ID_DOCS_RETENTION_NAME })
  async daily(): Promise<void> {
    try {
      const r = await this.run();
      if (r.skipped === null && (r.accountsWorked > 0 || r.stoppedEarly)) {
        this.logger.log(
          `ID documents sweep: ${r.accountsFinished} account(s) finished, ${r.accountsLeft} left for the next run, ${r.filesErased} file(s) deleted${r.stoppedEarly ? ' (stopped at the time budget)' : ''}.`,
        );
      }
    } catch (e) {
      // The name only; tomorrow's run picks up whatever this one did not.
      this.logger.error(
        `ID documents sweep failed (${(e as Error).name ?? 'Error'})`,
      );
    }
  }

  async run(
    now: Date = new Date(),
    limits: IdDocsRetentionLimits = DEFAULT_LIMITS,
  ): Promise<IdDocsRetentionReport> {
    const report: IdDocsRetentionReport = {
      skipped: null,
      days: 0,
      cutoff: now,
      accountsWorked: 0,
      accountsFinished: 0,
      accountsLeft: 0,
      accountsHeldByOthers: 0,
      filesErased: 0,
      stoppedEarly: false,
    };
    if (this.running) {
      report.skipped = 'already_running';
      return report;
    }
    this.running = true;
    try {
      // The days kept decide what is deleted for good: read them fresh, and
      // do nothing at all when they cannot be read (a stale, shorter value
      // would delete what an admin has just asked to keep).
      if (!(await this.settings.refresh())) {
        report.skipped = 'setting_unreadable';
        this.logger.warn(
          'ID documents sweep: the settings could not be read; nothing was deleted',
        );
        return report;
      }
      report.days = this.settings.number(ID_DOCS_KEEP_DAYS_SETTING);
      report.cutoff = new Date(now.getTime() - report.days * DAY_MS);
      const bucket = this.remover?.isConfigured ? this.remover : null;
      if (!bucket) {
        // A server with no bucket cannot remove an object, and a row deleted
        // without its object would hide a file that is still there.
        if ((await this.countDue(report.cutoff, now)) > 0) {
          this.logger.warn(
            'ID documents sweep: accounts are due but this server has no bucket; nothing was deleted',
          );
        }
        report.skipped = 'no_bucket';
        return report;
      }

      const deadline = Date.now() + limits.budgetMs;
      let after: string | null = null;
      for (;;) {
        const due: Array<{ wawuUserId: string }> =
          await this.prisma.accountDeletion.findMany({
            where: {
              ...this.dueWhere(report.cutoff, now),
              ...(after ? { wawuUserId: { gt: after } } : {}),
            },
            orderBy: { wawuUserId: 'asc' },
            take: limits.accountPage,
            select: { wawuUserId: true },
          });
        if (due.length === 0) break;
        after = due[due.length - 1].wawuUserId;
        for (const { wawuUserId } of due) {
          if (Date.now() >= deadline) {
            report.stoppedEarly = true;
            return report;
          }
          if (!(await this.claim(wawuUserId, report.cutoff, now, limits))) {
            report.accountsHeldByOthers += 1;
            continue;
          }
          report.accountsWorked += 1;
          let outcome: AccountOutcome = { erased: 0, finished: false };
          try {
            outcome = await this.eraseAccount(
              bucket,
              wawuUserId,
              report.days,
              now,
              limits,
              deadline,
            );
          } catch (e) {
            // The name only; the rows left are the list for the next run.
            this.logger.error(
              `ID documents sweep: one account failed (${(e as Error).name ?? 'Error'}); it is tried again next run`,
            );
          } finally {
            await this.release(wawuUserId);
          }
          report.filesErased += outcome.erased;
          if (outcome.finished) report.accountsFinished += 1;
          else report.accountsLeft += 1;
        }
        if (due.length < limits.accountPage) break;
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Deletions completed before the cutoff whose documents are not yet finished and not held. */
  private dueWhere(cutoff: Date, now: Date) {
    return {
      status: 'purged',
      purgedAt: { lt: cutoff },
      idDocsErasedAt: null,
      OR: [{ idDocsClaimedUntil: null }, { idDocsClaimedUntil: { lt: now } }],
    };
  }

  private countDue(cutoff: Date, now: Date): Promise<number> {
    return this.prisma.accountDeletion.count({
      where: this.dueWhere(cutoff, now),
    });
  }

  /** True when this server now holds the account: one winner, however many servers ask. */
  private async claim(
    wawuUserId: string,
    cutoff: Date,
    now: Date,
    limits: IdDocsRetentionLimits,
  ): Promise<boolean> {
    const { count } = await this.prisma.accountDeletion.updateMany({
      where: { wawuUserId, ...this.dueWhere(cutoff, now) },
      data: { idDocsClaimedUntil: new Date(now.getTime() + limits.claimMs) },
    });
    return count === 1;
  }

  /** Frees the account for the next run. Never throws: an unfreed claim runs out on its own. */
  private async release(wawuUserId: string): Promise<void> {
    try {
      await this.prisma.accountDeletion.updateMany({
        where: { wawuUserId, idDocsErasedAt: null },
        data: { idDocsClaimedUntil: null },
      });
    } catch {
      /* the claim expires by itself */
    }
  }

  private async eraseAccount(
    bucket: StorageRemover,
    wawuUserId: string,
    days: number,
    now: Date,
    limits: IdDocsRetentionLimits,
    deadline: number,
  ): Promise<AccountOutcome> {
    let erased = 0;
    const { owner } = await listKeptFiles(this.prisma, wawuUserId);
    for (let i = 0; i < owner.length; i += limits.filePage) {
      if (Date.now() >= deadline) break;
      const page = owner.slice(i, i + limits.filePage);
      // The bucket first, holding nothing; a missing object is "gone".
      const result = await bucket.removeMany(
        page.map((r) => r.key),
        deadline,
      );
      const gone = new Set(result.gone);
      const ids = page.filter((r) => gone.has(r.key)).map((r) => r.id);
      erased += await this.deleteRows(wawuUserId, ids);
      if (result.stopped) break;
    }

    // Finished only when nothing set aside is left for this person.
    const rest = await listKeptFiles(this.prisma, wawuUserId);
    if (rest.owner.length > 0) return { erased, finished: false };
    const { count } = await this.prisma.accountDeletion.updateMany({
      where: { wawuUserId, status: 'purged', idDocsErasedAt: null },
      data: {
        idDocsErasedAt: now,
        idDocsKeepDays: days,
        idDocsClaimedUntil: null,
      },
    });
    if (count === 1) {
      const row = await this.prisma.accountDeletion.findUnique({
        where: { wawuUserId },
        select: { idDocsErased: true },
      });
      this.logger.log(
        `ID documents of a deleted account erased: ${row?.idDocsErased ?? erased} file(s), kept ${days} day(s).`,
      );
    }
    return { erased, finished: count === 1 };
  }

  /**
   * Deletes the rows of files whose objects are gone and adds them to the
   * account's count in one short transaction (no network call inside). Only
   * rows still filed under the deleted account are deleted.
   */
  private async deleteRows(
    wawuUserId: string,
    ids: readonly string[],
  ): Promise<number> {
    if (ids.length === 0) return 0;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.storageObject.deleteMany({
        where: { id: { in: [...ids] }, wawuUserId: DELETED_CREATOR_ID },
      });
      if (count > 0) {
        await tx.accountDeletion.update({
          where: { wawuUserId },
          data: { idDocsErased: { increment: count } },
        });
      }
      return count;
    });
  }
}
