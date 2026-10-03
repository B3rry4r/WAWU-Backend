/**
 * When a creator who leaves paid questions unanswered is warned, and when
 * paid messages switch off (task INBOX-09, DECISIONS R-13).
 *
 * R-13 names the two lines (warn at 20%, pause at 30%) and the pause (7
 * days); INBOX-09 names the rolling 30-day window. They are read from the
 * environment so a ruling that moves one never needs a deploy of code, and
 * default to the ruled figures. A value that is not a whole number in range
 * falls back to the default rather than switching enforcement off.
 *
 * PROVISIONAL(PAID-DM-MIN-QUESTIONS, owner=YOU, why=no ruling says how many paid questions a creator must have had in the window before the rate counts; at 1 a creator's first missed question reads as 100% and pauses them)
 *
 * The default is 1, which is R-13 read literally: any rate at or over a line
 * acts. The owner may name a higher minimum.
 */
export interface PaidDmPauseConfig {
  /** Warn at or over this share of resolved questions unanswered (R-13: 20). */
  warnAtPct: number;
  /** Switch paid messages off at or over this share (R-13: 30). */
  pauseAtPct: number;
  /** The rolling window the share is taken over, in days (INBOX-09: 30). */
  windowDays: number;
  /** How long paid messages stay off, in days (R-13: 7). */
  pauseDays: number;
  /** Questions needed in the window before the share counts. */
  minQuestions: number;
}

function whole(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Read on every call, so a test (or an operator) can change it without a rebuild. */
export function paidDmPauseConfig(): PaidDmPauseConfig {
  const pauseAtPct = whole('PAID_DM_PAUSE_AT_PCT', 30, 1, 100);
  const warnAtPct = Math.min(
    whole('PAID_DM_WARN_AT_PCT', 20, 1, 100),
    pauseAtPct,
  );
  return {
    warnAtPct,
    pauseAtPct,
    windowDays: whole('PAID_DM_WINDOW_DAYS', 30, 1, 365),
    pauseDays: whole('PAID_DM_PAUSE_DAYS', 7, 1, 365),
    minQuestions: whole('PAID_DM_MIN_QUESTIONS', 1, 1, 10_000),
  };
}
