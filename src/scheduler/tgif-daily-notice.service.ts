import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { TgifContentService } from '../tgif/content/tgif-content.service';
import {
  LAGOS_UTC_OFFSET_MINUTES,
  TGIF_NOTICE_CATCH_UP_MINUTES,
  TGIF_NOTICE_CHUNK,
  TGIF_NOTICE_EVERY,
  TGIF_NOTICE_KEEP_DAYS,
  TGIF_NOTICE_RUN_BUDGET_MS,
  TGIF_NOTIFICATION_TIME_DEFAULT,
  TGIF_NOTIFICATION_TIME_KEY,
  parseNoticeTime,
} from './tgif-daily-notice.config';

/** Why a run did or did not write, for the log and for the specs. */
export type TgifNoticeState =
  /** Not yet the set time in Lagos. */
  | 'early'
  /** The catch-up window after the set time is over. */
  | 'late'
  /** The book has no TGIF for the day: nothing is sent. */
  | 'no_tgif'
  /** Another run in this process is still working. */
  | 'busy'
  /** The run looked at everyone due. `written` may be 0. */
  | 'done'
  /** The run stopped on its time budget; the next look carries on. */
  | 'budget'
  /** A write failed and was undone; the next look tries again. */
  | 'failed';

export interface TgifNoticeReport {
  /** The Lagos calendar day, YYYY-MM-DD. */
  day: string;
  state: TgifNoticeState;
  /** Notices written by this run. */
  written: number;
}

const DAY_MS = 86_400_000;

/** The Lagos calendar day (YYYY-MM-DD) and minutes after midnight there. */
export function lagosClock(now: Date): { day: string; minutes: number } {
  const lagos = new Date(now.getTime() + LAGOS_UTC_OFFSET_MINUTES * 60_000);
  return {
    day: lagos.toISOString().slice(0, 10),
    minutes: lagos.getUTCHours() * 60 + lagos.getUTCMinutes(),
  };
}

/**
 * The daily TGIF notice (HOME-16, R-59: TGIF leaves Home for Explore and a
 * daily notification).
 *
 * WHAT IT DOES. Every few minutes the job asks one question: "is it time to
 * make today's notices, and who is still owed one?". From the set time in
 * Lagos (`tgif_notification_time`, default 07:00) until the catch-up window
 * closes it writes one `tgif_daily` notification for each person who has TGIF
 * on (`TgifPreference.show`, true unless they turned it off in Settings, Z2
 * "TGIF each morning"), titled with that day's TGIF. The phone push is not
 * sent here: the notification row is the outbox, and the push sender
 * (INBOX-03) sends it, after reading the person's switch again.
 *
 * ONE PER PERSON PER DAY. `TgifDailyNotice` has the person and the Lagos day
 * as its primary key. A person is claimed with `INSERT ... ON CONFLICT DO
 * NOTHING RETURNING` in the SAME transaction as their notification, so any
 * number of hub instances, or the job running twice, make exactly one. A
 * failed write rolls the claim back and the next look tries again. A person
 * who turns TGIF on after the set time is reached by the next look inside the
 * window; one who turns it off is skipped at the claim, and a notice already
 * written is not pushed (push-sender reads the switch before sending).
 *
 * A DAY WITH NO TGIF sends nothing: if the book cannot give the day, the run
 * says so in the log and writes nothing.
 *
 * NO NETWORK, NO LONG LOCK. The only work is database work in short
 * transactions of at most `TGIF_NOTICE_CHUNK` people, with no call to Expo,
 * the bucket or any provider inside one. The rows the transaction takes are
 * the people's own claim rows; nothing is held across a pause.
 *
 * Like VerificationReminderService, `@Cron` is inert without
 * ScheduleModule.forRoot() (app.module.ts), so a spec that mounts this
 * provider alone gets the method and no timer.
 */
@Injectable()
export class TgifDailyNoticeService {
  private readonly logger = new Logger(TgifDailyNoticeService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly content: TgifContentService,
    private readonly config: ConfigService,
  ) {}

  @Cron(TGIF_NOTICE_EVERY, { name: 'tgif-daily-notice' })
  async tick(): Promise<void> {
    try {
      const report = await this.run();
      if (report.written > 0 || report.state === 'failed') {
        this.logger.log(
          `TGIF notice for ${report.day}: ${report.written} written (${report.state}).`,
        );
      }
    } catch (error) {
      this.logger.error(
        'TGIF notice run failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** The set time as minutes after midnight in Lagos; a bad setting falls back to the default and says so. */
  noticeMinutes(): number {
    const raw = this.config.get<string>(TGIF_NOTIFICATION_TIME_KEY);
    if (raw === undefined || raw.trim() === '') {
      return parseNoticeTime(TGIF_NOTIFICATION_TIME_DEFAULT) as number;
    }
    const parsed = parseNoticeTime(raw);
    if (parsed !== null) return parsed;
    this.logger.warn(
      `${TGIF_NOTIFICATION_TIME_KEY} is not a time of day (HH:MM); using ${TGIF_NOTIFICATION_TIME_DEFAULT}.`,
    );
    return parseNoticeTime(TGIF_NOTIFICATION_TIME_DEFAULT) as number;
  }

  /**
   * One look, callable directly with a chosen `now`. Idempotent: a second
   * call for the same day writes nothing for anyone already done.
   */
  async run(now: Date = new Date()): Promise<TgifNoticeReport> {
    const { day, minutes } = lagosClock(now);
    const start = this.noticeMinutes();
    if (minutes < start) return { day, state: 'early', written: 0 };
    if (minutes >= start + TGIF_NOTICE_CATCH_UP_MINUTES) {
      return { day, state: 'late', written: 0 };
    }

    // The words come from the book. No entry for the day, no notice.
    let words: { series: string; verseReference: string };
    try {
      const view = this.content.day(day, null);
      words = { series: view.series, verseReference: view.verseReference };
    } catch (error) {
      this.logger.warn(
        `No TGIF for ${day}, so no notice is sent (${error instanceof Error ? error.message : String(error)}).`,
      );
      return { day, state: 'no_tgif', written: 0 };
    }

    if (this.running) return { day, state: 'busy', written: 0 };
    this.running = true;
    const startedAt = Date.now();
    let written = 0;
    let after = '';
    try {
      for (;;) {
        if (Date.now() - startedAt > TGIF_NOTICE_RUN_BUDGET_MS) {
          return { day, state: 'budget', written };
        }
        const chunk = await this.claimAndWrite(day, words, after);
        if (chunk === null) return { day, state: 'failed', written };
        // Nobody due after the last id this run looked at: everyone is done.
        if (chunk.last === null) break;
        after = chunk.last;
        written += chunk.written;
      }
      await this.prune(day);
      return { day, state: 'done', written };
    } finally {
      this.running = false;
    }
  }

  /**
   * One short transaction: claim up to a chunk of people after `after` who are
   * still owed today's notice (switch on, no marker yet, no deletion asked
   * for) and write their notifications. All database work. Answers the last
   * id it looked at (null when nobody was due), so the run moves on in id
   * order and never reads the same people twice. `null` when it failed and was
   * undone.
   */
  private async claimAndWrite(
    day: string,
    words: { series: string; verseReference: string },
    after: string,
  ): Promise<{ last: string | null; written: number } | null> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Picked and claimed in ONE statement, so the switch is read at the
          // moment of the claim. ON CONFLICT DO NOTHING is the whole of the
          // multi-instance safety: a person another run claimed first is not
          // returned in `ids`.
          const [row] = await tx.$queryRaw<
            Array<{ ids: string[]; last: string | null }>
          >`
            WITH due AS (
              SELECT u."wawuUserId" AS id
              FROM "UserProfile" u
              LEFT JOIN "TgifPreference" p ON p."userWawuId" = u."wawuUserId"
              WHERE u."wawuUserId" > ${after}
                AND COALESCE(p."show", true)
                AND NOT EXISTS (
                  SELECT 1 FROM "TgifDailyNotice" n
                  WHERE n."userWawuId" = u."wawuUserId" AND n."day" = ${day}::date)
                AND NOT EXISTS (
                  SELECT 1 FROM "PushStoppedAccount" s
                  WHERE s."userWawuId" = u."wawuUserId")
              ORDER BY u."wawuUserId"
              LIMIT ${TGIF_NOTICE_CHUNK}),
            claimed AS (
              INSERT INTO "TgifDailyNotice" ("userWawuId", "day")
              SELECT id, ${day}::date FROM due
              ON CONFLICT DO NOTHING
              RETURNING "userWawuId")
            SELECT
              COALESCE((SELECT array_agg("userWawuId") FROM claimed), ARRAY[]::text[]) AS "ids",
              (SELECT max(id) FROM due) AS "last"`;
          const written = await this.notifications.emitTgifDaily(
            { day, ...words },
            row?.ids ?? [],
            tx,
          );
          return { last: row?.last ?? null, written };
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      this.logger.error(
        `TGIF notice write for ${day} failed and was undone`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /** Deletes markers older than the keep window. A marker only has to outlive the day it guards. */
  private async prune(day: string): Promise<void> {
    const cutoff = new Date(
      Date.parse(`${day}T00:00:00.000Z`) - TGIF_NOTICE_KEEP_DAYS * DAY_MS,
    );
    try {
      await this.prisma.tgifDailyNotice.deleteMany({
        where: { day: { lt: cutoff } },
      });
    } catch (error) {
      this.logger.warn(
        `Could not prune old TGIF notice markers (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
}
