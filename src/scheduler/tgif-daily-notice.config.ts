/**
 * The daily TGIF notice's settings (HOME-16, R-59).
 *
 * PROVISIONAL(TGIF-NOTIFICATION-TIME, owner=YOU, why=R-59 asks for a daily morning notice and names no hour; the task cut set 07:00 Africa/Lagos)
 *
 * `tgif_notification_time`: the time of day, in Africa/Lagos, from which the
 * day's TGIF notice is made. Read from the environment key
 * `TGIF_NOTIFICATION_TIME` as `HH:MM` (24 hours); anything else is ignored
 * with a warning and the default is used. The owner may override.
 *
 * Africa/Lagos has no daylight saving: it is UTC+1 all year, so the offset
 * below is exact and no time zone database is read.
 */
export const TGIF_NOTIFICATION_TIME_KEY = 'TGIF_NOTIFICATION_TIME';
export const TGIF_NOTIFICATION_TIME_DEFAULT = '07:00';
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
