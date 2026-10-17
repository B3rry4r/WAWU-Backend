/**
 * The daily TGIF notice's settings (HOME-16, R-59; HOME-17, owner answer 32).
 *
 * Both figures are admin settings (the registry in src/plan-settings, R-65),
 * read live on every look, so an edit shows without a restart:
 * - `tgif_notification_time`: the time of day, in Africa/Lagos, from which the
 *   day's TGIF notice is made (`HH:MM`, 24 hours; launch value 07:00).
 * - `tgif_notice_retention_days`: how many days a made notice is kept before
 *   the clean-up clears it (a whole number of 1 or more; launch value 30).
 * The launch values are in plan-settings.defaults.json, not in code. The
 * environment key `TGIF_NOTIFICATION_TIME` that HOME-16 read is retired: nothing
 * reads it.
 *
 * Africa/Lagos has no daylight saving: it is UTC+1 all year, so the offset
 * below is exact and no time zone database is read.
 */
export const TGIF_NOTIFICATION_TIME_SETTING = 'tgif_notification_time';
export const TGIF_NOTICE_RETENTION_SETTING = 'tgif_notice_retention_days';
export const TGIF_NOTICE_TIMEZONE = 'Africa/Lagos';
export const LAGOS_UTC_OFFSET_MINUTES = 60;

/**
 * PROVISIONAL(TGIF-NOTICE-CATCH-UP, owner=YOU, why=no ruling says how late in the day a missed morning notice is still worth making)
 *
 * The job looks every `TGIF_NOTICE_EVERY` (a cron expression, server time),
 * and makes the day's notices from the set time until `TGIF_NOTICE_CATCH_UP_MINUTES`
 * later. A hub that was down at the set time still makes them when it is back
 * inside the window, and nobody gets a "morning" notice after it. Within the
 * window a person who has just turned TGIF on, or just joined, is reached by
 * the next look.
 */
export const TGIF_NOTICE_EVERY = '*/5 * * * *';
export const TGIF_NOTICE_CATCH_UP_MINUTES = 4 * 60;

/** People handled per transaction. A page size, never a cap on the run. */
export const TGIF_NOTICE_CHUNK = 500;

/**
 * PROVISIONAL(TGIF-NOTICE-KEEP, owner=YOU, why=the marker only has to outlive the day it guards; no ruling says how long)
 *
 * How many days a "notice made" marker is kept. Older ones are deleted at the
 * end of a run, so the table does not grow for ever.
 */
export const TGIF_NOTICE_KEEP_DAYS = 3;

/** The most a run works for before it stops and leaves the rest to the next look. */
export const TGIF_NOTICE_RUN_BUDGET_MS = 4 * 60_000;

/**
 * `HH:MM` as minutes after midnight, or null when it is not a time of day.
 */
export function parseNoticeTime(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The clean-up of old daily notices (HOME-17, owner answer 32: notices older
 * than 30 days are cleared). It runs once a day, in server time, off the
 * morning peak. The days kept are the admin setting
 * `tgif_notice_retention_days`.
 */
export const TGIF_NOTICE_RETENTION_EVERY = '17 2 * * *';
export const TGIF_NOTICE_RETENTION_NAME = 'tgif-notice-retention';

/** Notices removed per statement. A page size, never a cap on the run. */
export const TGIF_NOTICE_RETENTION_BATCH = 1000;

/** The most a clean-up works for before it stops and leaves the rest to tomorrow. */
export const TGIF_NOTICE_RETENTION_BUDGET_MS = 4 * 60_000;

/** The `Notification.kind` the clean-up is limited to. No other kind is ever touched. */
export const TGIF_DAILY_KIND = 'tgif_daily';
