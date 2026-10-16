/**
 * The money-in notice sweep's settings (task WALLET-10).
 */

/** Config keys. None is required: the server starts without it. */
export const MONEY_IN_NOTICE_CONFIG_KEYS = {
  windowHours: 'MONEY_IN_NOTICE_WINDOW_HOURS',
} as const;

/**
 * PROVISIONAL(MONEY-IN-NOTICE-WINDOW, owner=YOU, why=no ruling says how long after the Hub learned of a credit the person is still told; 72 hours is the ledger's own confirm window and Fintava's webhook retry horizon)
 *
 * How far back the sweep looks for a credit that was not told yet, counted
 * from when the Hub first wrote the ledger row (`createdAt`). Every credit is
 * normally told within a minute; the window only bounds what a sweep reads
 * after the Hub was stopped for days. A credit that stayed `pending` longer
 * than this before it completed is in the history but is not told.
 *
 * PROVISIONAL(MONEY-IN-NOTICE-SWEEP, owner=YOU, why=no ruling says how soon a person must hear of money in; a pass every 10 seconds keeps the wait inside the push sender's own 10 second pass)
 */
export const MONEY_IN_NOTICE_DEFAULTS = {
  windowHours: 72,
  /** Seconds between two passes of the sweep. */
  sweepSeconds: 10,
  /** Credits dealt with per read. */
  batch: 50,
  /** Reads per pass, so one pass never runs into the next. */
  passes: 4,
  /** The longest rest before a credit the sweep could not tell is tried again. */
  maxRestMinutes: 60,
} as const;

export function moneyInNoticeWindowMs(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  if (text === '') return MONEY_IN_NOTICE_DEFAULTS.windowHours * 3_600_000;
  const hours = Number(text);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) {
    throw new Error(
      `${MONEY_IN_NOTICE_CONFIG_KEYS.windowHours} must be a whole number of hours from 1 to 720.`,
    );
  }
  return hours * 3_600_000;
}
