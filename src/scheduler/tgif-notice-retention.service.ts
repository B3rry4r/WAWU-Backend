import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import {
  TGIF_DAILY_KIND,
  TGIF_NOTICE_RETENTION_BATCH,
  TGIF_NOTICE_RETENTION_BUDGET_MS,
  TGIF_NOTICE_RETENTION_EVERY,
  TGIF_NOTICE_RETENTION_NAME,
  TGIF_NOTICE_RETENTION_SETTING,
} from './tgif-daily-notice.config';

const DAY_MS = 86_400_000;

/** What one clean-up did. */
export interface TgifNoticeRetentionReport {
  /** Notices made before this were due. */
  cutoff: Date;
  /** The days kept, as the admin setting held them at the start of the run. */
  days: number;
  /** Notices removed by this run. */
  deleted: number;
  /** Statements run (each one batch, each a transaction of its own). */
  batches: number;
  /** True when the time budget ended the run before it ran out of notices. */
  stoppedEarly: boolean;
  /** True when this process was already running the clean-up, so this call did nothing. */
  skipped: boolean;
}

/** How one run is bounded. A spec passes smaller ones. */
export interface TgifNoticeRetentionLimits {
  batch: number;
  budgetMs: number;
}

const DEFAULT_LIMITS: TgifNoticeRetentionLimits = {
  batch: TGIF_NOTICE_RETENTION_BATCH,
  budgetMs: TGIF_NOTICE_RETENTION_BUDGET_MS,
};

/**
 * Clears the daily TGIF notices that are older than the days kept (HOME-17,
 * owner answer 32; the days are the admin setting `tgif_notice_retention_days`,
 * launch value 30).
 *
 * SCOPE. Only `Notification` rows of kind `tgif_daily` (the ones HOME-16
 * writes) are ever selected. Every other kind the app or the web shows, and a
 * `tgif_daily` notice younger than the days kept, is not touched. Each removed
 * notice takes its `NotificationTarget` with it (that relation cascades). The
 * once-per-person-per-day marker (`TgifDailyNotice`) is not touched here: it
 * lives 3 days and is pruned by the notice job, so clearing a notice can never
 * let a day's notice be made twice.
 *
 * BOUNDED. A batch is one statement: it picks at most `batch` of the oldest
 * due rows, locks them (`FOR UPDATE SKIP LOCKED`) and deletes them together,
 * so it is a transaction of its own and no lock outlives it. Nothing holds a
 * transaction, a connection or a lock between batches, and nothing in a batch
 * calls the network. A run stops at its time budget and leaves the rest to
 * the next day.
 *
 * ONCE, WITH TWO SERVERS. Within a process a second call while one is running
 * does nothing. Across processes, two servers that start the job at the same
 * moment share the due rows between them through SKIP LOCKED: each notice is
 * deleted by exactly one of them, and neither waits on the other. A second
 * run finds nothing and writes nothing.
 *
 * LIVE. The days kept are read at the start of every run, so an admin's edit
 * applies at the next run with no restart. The setting is at least 1 day, so
 * a notice made this morning is never cleared the same day.
 *
 * Like TgifDailyNoticeService, `@Cron` is inert without ScheduleModule.forRoot()
 * (app.module.ts); a spec calls `run` directly with a chosen `now`.
 */
@Injectable()
export class TgifNoticeRetentionService {
  private readonly logger = new Logger(TgifNoticeRetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
  ) {}

  @Cron(TGIF_NOTICE_RETENTION_EVERY, { name: TGIF_NOTICE_RETENTION_NAME })
  async daily(): Promise<void> {
    try {
      const report = await this.run();
      if (report.deleted > 0 || report.stoppedEarly) {
        this.logger.log(
          `TGIF notice clean-up: ${report.deleted} notice(s) older than ${report.days} day(s) cleared${report.stoppedEarly ? ' (stopped at the time budget)' : ''}.`,
        );
      }
    } catch (error) {
      // Tomorrow's run picks up whatever this one did not.
      this.logger.error(
        'TGIF notice clean-up failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** One clean-up, callable directly with a chosen `now`. Safe to run twice. */
  async run(
    now: Date = new Date(),
    limits: TgifNoticeRetentionLimits = DEFAULT_LIMITS,
  ): Promise<TgifNoticeRetentionReport> {
    const days = this.settings.number(TGIF_NOTICE_RETENTION_SETTING);
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const report: TgifNoticeRetentionReport = {
      cutoff,
      days,
      deleted: 0,
      batches: 0,
      stoppedEarly: false,
      skipped: false,
    };
    if (this.running) {
      report.skipped = true;
      return report;
    }
    this.running = true;
    const deadline = Date.now() + limits.budgetMs;
    try {
      for (;;) {
        if (Date.now() >= deadline) {
          report.stoppedEarly = true;
          break;
        }
        const n = await this.deleteBatch(cutoff, limits.batch);
        report.batches += 1;
        report.deleted += n;
        if (n < limits.batch) break;
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /**
   * Deletes up to `batch` due notices in one statement and answers how many.
   * The CTE is MATERIALIZED so the rows are picked and locked once (an inlined
   * `IN (SELECT ... FOR UPDATE SKIP LOCKED)` can be run again by the planner
   * and take more than `batch`). The kind is written into the statement as a
   * literal (a fixed string from this package, never input) so the partial
   * index on that kind always applies; the oldest go first.
   */
  private async deleteBatch(cutoff: Date, batch: number): Promise<number> {
    const kind = Prisma.raw(`'${TGIF_DAILY_KIND}'`);
    const [row] = await this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      WITH due AS MATERIALIZED (
        SELECT "id" FROM "Notification"
         WHERE "kind" = ${kind}
           AND "createdAt" < ${cutoff}::timestamp(3)
         ORDER BY "createdAt"
         LIMIT ${batch}
         FOR UPDATE SKIP LOCKED
      ), gone AS (
        DELETE FROM "Notification" AS n
         USING due
         WHERE n."id" = due."id"
        RETURNING n."id"
      )
      SELECT count(*)::int AS "n" FROM gone`);
    return row?.n ?? 0;
  }
}
