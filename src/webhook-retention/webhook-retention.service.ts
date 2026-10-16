import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  clearableStates,
  heldStates,
  WEBHOOK_RETENTION_CONFIG_KEYS,
  WEBHOOK_RETENTION_DEFAULTS,
  WEBHOOK_RETENTION_SCHEDULE,
  type WebhookRetentionTable,
  webhookRetentionMs,
} from './webhook-retention-config';

/** What one run did to one table. */
export interface WebhookRetentionTableReport {
  /** Bodies cleared by this run. */
  cleared: number;
  /** Statements run (each one batch, each a transaction of its own). */
  batches: number;
  /** True when the time budget ended the run before it ran out of rows. */
  stoppedEarly: boolean;
  /** The name of the error that ended this table's run, or null. The other table's run still goes ahead. */
  error: string | null;
  /**
   * Rows past the period that still hold their body because their state is
   * held (pending, failed, unrecognised), by state. Counted after the
   * clearing, so a row is never counted and cleared in one run.
   */
  heldPastPeriod: Record<string, number>;
}

/** What one run did. */
export interface WebhookRetentionReport {
  /** Rows received before this were due. */
  cutoff: Date;
  /** True when this process was already running the job, so this call did nothing. */
  skipped: boolean;
  FintavaWebhookEvent: WebhookRetentionTableReport;
  NuvionWebhookEvent: WebhookRetentionTableReport;
}

/** How one run is bounded. A spec passes smaller ones. */
export interface WebhookRetentionLimits {
  batch: number;
  budgetMs: number;
}

const TABLES: readonly WebhookRetentionTable[] = [
  'FintavaWebhookEvent',
  'NuvionWebhookEvent',
];

/** The enum type of each table's `processingStatus`, for the array cast below. */
const STATE_ENUM: Record<WebhookRetentionTable, string> = {
  FintavaWebhookEvent: 'FintavaWebhookProcessing',
  NuvionWebhookEvent: 'NuvionWebhookProcessing',
};

const empty = (): WebhookRetentionTableReport => ({
  cleared: 0,
  batches: 0,
  stoppedEarly: false,
  error: null,
  heldPastPeriod: {},
});

/**
 * Provider webhook deliveries are not kept for ever (task FIX-20).
 *
 * Once a day, clears the raw body and the parsed copy of every Fintava and
 * Nuvion delivery that is older than the retention period (WEBHOOK_RETENTION_DAYS,
 * 90 by default, counted from the time the delivery was received) and whose
 * state says nothing reads it any more (WEBHOOK_STATE_RULES: `processed`, and
 * Nuvion's `test`). A delivery that is still `pending`, or `failed` or
 * `unrecognised` and so held for review, keeps its body whatever its age.
 *
 * It clears the body and the parsed copy and nothing else. The row stays with
 * its id, event, references, the SHA-256 of the body, the outcome and the
 * times, so a delivery the provider sends again is still a repeat: the
 * receiver's insert lands on the same unique key and answers `duplicate`
 * (Fintava: `bodySha256`; Nuvion: `eventId`, and `signedAt` with
 * `bodySha256`). Nothing here touches the receivers, the ledger or the
 * dispatcher, and none of them reads a body this job clears.
 *
 * Safe to run twice and while a delivery arrives:
 * - One batch is one statement: the rows to clear are picked, locked
 *   (`FOR UPDATE SKIP LOCKED`) and cleared together, so a row is cleared by
 *   one run only, two Hub processes running the job at once share the rows
 *   between them, and a row a consumer holds is left to the next run. The
 *   statement is a transaction of its own, `batch` rows at most, so no lock
 *   outlives it.
 * - A repeat of a delivery whose row is in the batch being cleared right now
 *   waits for that one statement (Postgres makes an insert that conflicts
 *   with a row being updated wait for the updater) and then answers
 *   `duplicate`: the clearing does not change the unique key. A repeat of any
 *   other row does not wait.
 * - A delivery that arrives during a run is a new row, received after the
 *   cutoff, conflicts with nothing and is never a candidate.
 * - A second run finds nothing to clear (`bodyClearedAt` is set) and writes
 *   nothing.
 *
 * Nothing it logs holds a body: counts, table names and state names only.
 */
@Injectable()
export class WebhookRetentionService {
  private readonly logger = new Logger(WebhookRetentionService.name);
  private readonly retentionMs: number;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.retentionMs = webhookRetentionMs(
      config.get<string>(WEBHOOK_RETENTION_CONFIG_KEYS.days),
    );
  }

  /** The daily run. Where ScheduleModule.forRoot() is loaded (AppModule); a spec calls `run` directly. */
  @Cron(WEBHOOK_RETENTION_SCHEDULE.cron, {
    name: WEBHOOK_RETENTION_SCHEDULE.name,
  })
  async daily(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      // The name only; tomorrow's run picks up whatever this one did not.
      this.logger.error(
        `webhook retention: the run failed (${(e as Error).name ?? 'Error'})`,
      );
    }
  }

  /** One run over both tables. One at a time per process; other processes share the rows. */
  async run(
    now = new Date(),
    limits: WebhookRetentionLimits = WEBHOOK_RETENTION_DEFAULTS,
  ): Promise<WebhookRetentionReport> {
    const cutoff = new Date(now.getTime() - this.retentionMs);
    const report: WebhookRetentionReport = {
      cutoff,
      skipped: false,
      FintavaWebhookEvent: empty(),
      NuvionWebhookEvent: empty(),
    };
    if (this.running) {
      report.skipped = true;
      return report;
    }
    this.running = true;
    try {
      for (const table of TABLES) {
        // Each table has its own budget, so a long backlog in one cannot
        // starve the other; and one table's failure does not stop the other.
        const deadline = Date.now() + limits.budgetMs;
        try {
          report[table] = await this.clearTable(
            table,
            cutoff,
            now,
            limits.batch,
            deadline,
          );
        } catch (e) {
          // The name only; tomorrow's run picks up what this one did not.
          report[table].error = (e as Error).name ?? 'Error';
          this.logger.error(
            `webhook retention: ${table} failed (${report[table].error})`,
          );
        }
      }
      const said = TABLES.map((t) => {
        const r = report[t];
        const held = Object.entries(r.heldPastPeriod)
          .map(([state, n]) => `${state} ${n}`)
          .join(', ');
        return `${t} cleared ${r.cleared}${held ? ` (held past the period: ${held})` : ''}${r.stoppedEarly ? ' (stopped at the time budget)' : ''}${r.error ? ` (failed: ${r.error})` : ''}`;
      }).join('; ');
      this.logger.log(`webhook retention: ${said}`);
      return report;
    } finally {
      this.running = false;
    }
  }

  private async clearTable(
    table: WebhookRetentionTable,
    cutoff: Date,
    now: Date,
    batch: number,
    deadline: number,
  ): Promise<WebhookRetentionTableReport> {
    const report = empty();
    for (;;) {
      if (Date.now() >= deadline) {
        report.stoppedEarly = true;
        break;
      }
      const n = await this.clearBatch(table, cutoff, now, batch);
      report.batches += 1;
      report.cleared += n;
      if (n < batch) break;
    }
    report.heldPastPeriod = await this.countHeld(table, cutoff);
    return report;
  }

  /**
   * Clears up to `batch` rows in one statement and returns how many it
   * cleared. The CTE is MATERIALIZED so the rows are picked and locked once
   * (an inlined `IN (SELECT ... FOR UPDATE SKIP LOCKED)` can be run again by
   * the planner and take more than `batch`; see PushSenderService.claim).
   *
   * The table and enum names are fixed strings from this file, never input.
   * A Fintava row without its `bodySha256` is not cleared: that hash is the
   * key its repeat check reads, and a row without one has none to keep.
   */
  private async clearBatch(
    table: WebhookRetentionTable,
    cutoff: Date,
    now: Date,
    batch: number,
  ): Promise<number> {
    const tableName = Prisma.raw(`"${table}"`);
    const stateEnum = Prisma.raw(`"${STATE_ENUM[table]}"`);
    const hasKey =
      table === 'FintavaWebhookEvent'
        ? Prisma.sql`AND "bodySha256" IS NOT NULL`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH due AS MATERIALIZED (
        SELECT "id" FROM ${tableName}
         WHERE "bodyClearedAt" IS NULL
           AND "processingStatus" = ANY(${clearableStates(table)}::${stateEnum}[])
           AND "receivedAt" < ${cutoff}::timestamp(3)
           ${hasKey}
         LIMIT ${batch}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE ${tableName} AS e
         SET "rawBody" = ''::bytea,
             "payload" = 'null'::jsonb,
             "bodyClearedAt" = ${now}::timestamp(3)
        FROM due
       WHERE e."id" = due."id"
      RETURNING e."id"`);
    return rows.length;
  }

  /** Rows past the period that keep their body because their state is held, by state. */
  private async countHeld(
    table: WebhookRetentionTable,
    cutoff: Date,
  ): Promise<Record<string, number>> {
    const states = heldStates(table);
    const stateEnum = Prisma.raw(`"${STATE_ENUM[table]}"`);
    const tableName = Prisma.raw(`"${table}"`);
    const rows = await this.prisma.$queryRaw<
      Array<{ state: string; n: number }>
    >(Prisma.sql`
      SELECT "processingStatus"::text AS "state", count(*)::int AS "n"
        FROM ${tableName}
       WHERE "bodyClearedAt" IS NULL
         AND "processingStatus" = ANY(${states}::${stateEnum}[])
         AND "receivedAt" < ${cutoff}::timestamp(3)
       GROUP BY 1
       ORDER BY 1`);
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
