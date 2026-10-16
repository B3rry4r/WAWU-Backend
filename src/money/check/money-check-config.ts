import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The nightly check's settings (task MONEY-16). Every one is optional; a
 * setting left empty takes the default below. A setting that is set but
 * cannot be used stops the app at boot with a message that names it.
 *
 * Who is told and when are the owner's to give: the recipients and the hour
 * are PROVISIONAL until the owner names them. Nothing here is a rate, a fee
 * or a limit on a person's money.
 */
export const MONEY_CHECK_CONFIG_KEYS = {
  time: 'MONEY_CHECK_TIME',
  catchUpHours: 'MONEY_CHECK_CATCH_UP_HOURS',
  recipients: 'MONEY_CHECK_RECIPIENT_WAWU_IDS',
  overlapHours: 'MONEY_CHECK_OVERLAP_HOURS',
  lookbackDays: 'MONEY_CHECK_MAX_LOOKBACK_DAYS',
  settleMinutes: 'MONEY_CHECK_SETTLE_MINUTES',
  historyPages: 'MONEY_CHECK_HISTORY_PAGES',
  callGapMs: 'MONEY_CHECK_CALL_GAP_MS',
  maxMinutes: 'MONEY_CHECK_MAX_MINUTES',
  feeLookups: 'MONEY_CHECK_FEE_LOOKUPS',
  keepDays: 'MONEY_CHECK_KEEP_DAYS',
} as const;

/**
 * PROVISIONAL(MONEY-CHECK-TIME, owner=YOU, why=no ruling names the hour of the nightly check; 02:30 in Lagos is after the day's last settlements and before anyone is awake)
 *
 * When the check starts, as HH:MM Lagos time. `off` turns the schedule off
 * (a run can still be made by hand).
 */
export const DEFAULT_MONEY_CHECK_TIME = '02:30';

/**
 * PROVISIONAL(MONEY-CHECK-RECIPIENTS, owner=YOU, why=the owner names who is told; until then no report is emailed and the result is in the log and the table)
 *
 * Who is told, as WAWU ids (MONEY_CHECK_RECIPIENT_WAWU_IDS). The Hub holds no
 * address: WAWU ID owns each address and the wording of the email.
 */
export const DEFAULT_MONEY_CHECK_RECIPIENTS: readonly string[] = [];

/**
 * PROVISIONAL(MONEY-CHECK-CATCH-UP, owner=YOU, why=no ruling names how late a missed night may still be made; 6 hours keeps it before the working day)
 *
 * How long after its time a night's run may still start: a Hub that was down
 * at 02:30 and comes back at 05:00 still makes the night's run. Later than
 * this the night is left (the next night's run reads back past it), or made
 * by hand.
 */
export const DEFAULT_CATCH_UP_HOURS = 6;

/**
 * PROVISIONAL(MONEY-CHECK-WINDOW, owner=YOU, why=no ruling names how far back a nightly comparison reads; 96 hours is the ledger confirm window and a day and 35 days bounds the cost)
 *
 * How far before the last finished run's window the next one reads back, so
 * a row that settled late (the ledger's confirm window is 72 hours) is
 * compared again. 96 hours is that window and a day.
 */
export const DEFAULT_OVERLAP_HOURS = 96;

/**
 * The furthest back any run reads debits. Older rows are still covered by the
 * balance comparison, which is cumulative.
 */
export const DEFAULT_LOOKBACK_DAYS = 35;

/**
 * A movement younger than this is left to the next run: the provider's
 * merchant history is cached for about five minutes per page
 * (`sandbox/10-merchant-history.md`) and a webhook takes a sweep or two to
 * reach the ledger.
 */
export const DEFAULT_SETTLE_MINUTES = 30;

/** Pages of 100 rows read for one wallet before its history is called too long. */
export const DEFAULT_HISTORY_PAGES = 30;

/** A pause between two calls to the provider, so a night's run is gentle. */
export const DEFAULT_CALL_GAP_MS = 100;

/** A run that is still going after this many minutes stops and says so. */
export const DEFAULT_MAX_MINUTES = 180;

/** The most by-id lookups one run makes to check WAWU's charge on sends. */
export const DEFAULT_FEE_LOOKUPS = 2000;

/** How long finished runs are kept. */
export const DEFAULT_KEEP_DAYS = 120;

/**
 * How long a process keeps a run before another may take it over, and how
 * many tries a night gets before it is reported as not finished. These are
 * not settings: they are what makes two Hub processes safe.
 */
export const RUN_LEASE_MS = 10 * 60_000;
export const RUN_ATTEMPTS = 3;
/** The rest between a failed try and the next. */
export const RUN_RETRY_GAP_MS = 15 * 60_000;

/** A set but unusable setting. Stops the app at boot. */
export class MoneyCheckConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyCheckConfigError';
  }
}

function blank(raw: string | undefined | null): boolean {
  return raw === undefined || raw === null || raw.trim() === '';
}

/** A whole number from `min` to `max`; empty means `fallback`. */
export function wholeSetting(
  raw: string | undefined | null,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (blank(raw)) return fallback;
  const text = raw!.trim();
  const n = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new MoneyCheckConfigError(
      `${key} must be a whole number from ${min} to ${max}.`,
    );
  }
  return n;
}

/**
 * `HH:MM` as minutes after midnight, or `off`. Empty means the default.
 * Returns null for `off`.
 */
export function timeSetting(raw: string | undefined | null): number | null {
  const key = MONEY_CHECK_CONFIG_KEYS.time;
  const text = blank(raw) ? DEFAULT_MONEY_CHECK_TIME : raw!.trim();
  if (text.toLowerCase() === 'off') return null;
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text);
  if (!m) {
    throw new MoneyCheckConfigError(
      `${key} must be a time such as 02:30 (Lagos), or off.`,
    );
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/** WAWU ids, comma separated, each a plain id. Empty means nobody. */
export function recipientsSetting(
  raw: string | undefined | null,
): readonly string[] {
  if (blank(raw)) return DEFAULT_MONEY_CHECK_RECIPIENTS;
  const ids = raw!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new MoneyCheckConfigError(
        `${MONEY_CHECK_CONFIG_KEYS.recipients} must be WAWU ids separated by commas.`,
      );
    }
  }
  return [...new Set(ids)];
}

/** What the nightly check reads from config. Read once at boot. */
@Injectable()
export class MoneyCheckSettings {
  /** Minutes after Lagos midnight the run starts; null: off. */
  readonly minuteOfDay: number | null;
  readonly catchUpMs: number;
  /** The WAWU ids the report is handed to WAWU ID for. */
  readonly recipients: readonly string[];
  readonly overlapMs: number;
  readonly lookbackMs: number;
  readonly settleMs: number;
  readonly historyPages: number;
  readonly callGapMs: number;
  readonly maxRunMs: number;
  readonly feeLookups: number;
  readonly keepMs: number;
  /**
   * Waits before asking again about a wallet whose ledger moved while the
   * provider was being asked. Not a setting: a spec shortens them.
   */
  recheckMs: readonly number[] = [3_000, 10_000];
  /** Waits before a read the provider could not answer is tried again. */
  retryMs: readonly number[] = [1_000, 5_000];

  constructor(config: ConfigService) {
    const K = MONEY_CHECK_CONFIG_KEYS;
    const get = (key: string) => config.get<string>(key);
    const HOUR = 3_600_000;
    this.minuteOfDay = timeSetting(get(K.time));
    this.catchUpMs =
      wholeSetting(
        get(K.catchUpHours),
        K.catchUpHours,
        DEFAULT_CATCH_UP_HOURS,
        1,
        23,
      ) * HOUR;
    this.recipients = recipientsSetting(get(K.recipients));
    this.overlapMs =
      wholeSetting(
        get(K.overlapHours),
        K.overlapHours,
        DEFAULT_OVERLAP_HOURS,
        1,
        720,
      ) * HOUR;
    this.lookbackMs =
      wholeSetting(
        get(K.lookbackDays),
        K.lookbackDays,
        DEFAULT_LOOKBACK_DAYS,
        1,
        366,
      ) *
      24 *
      HOUR;
    this.settleMs =
      wholeSetting(
        get(K.settleMinutes),
        K.settleMinutes,
        DEFAULT_SETTLE_MINUTES,
        5,
        720,
      ) * 60_000;
    this.historyPages = wholeSetting(
      get(K.historyPages),
      K.historyPages,
      DEFAULT_HISTORY_PAGES,
      1,
      500,
    );
    this.callGapMs = wholeSetting(
      get(K.callGapMs),
      K.callGapMs,
      DEFAULT_CALL_GAP_MS,
      0,
      10_000,
    );
    this.maxRunMs =
      wholeSetting(
        get(K.maxMinutes),
        K.maxMinutes,
        DEFAULT_MAX_MINUTES,
        10,
        720,
      ) * 60_000;
    this.feeLookups = wholeSetting(
      get(K.feeLookups),
      K.feeLookups,
      DEFAULT_FEE_LOOKUPS,
      0,
      100_000,
    );
    this.keepMs =
      wholeSetting(get(K.keepDays), K.keepDays, DEFAULT_KEEP_DAYS, 7, 3650) *
      24 *
      HOUR;
  }
}
