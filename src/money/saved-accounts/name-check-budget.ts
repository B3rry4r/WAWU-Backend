import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MoneyError } from '../money-error';
import { PersonWindowLimiter } from '../person-window-limiter';

/**
 * How many bank name checks one signed-in person may make in an hour (task
 * WALLET-37; R-51, G-764: "a person can run at most 30 bank name checks an
 * hour; the number is a setting").
 *
 * The setting is `name_check_per_hour` in the admin settings (launch value
 * 30). The admin-settings registry (TIER-06) is not merged yet, so the value
 * is read from this config key, once at boot, and moves into the registry
 * when TIER-06 lands (mobile repo SHARED-CHANGES, WALLET-37 row). Unset is
 * the launch value; a value that is set and is not a whole number from 1 to
 * 1,000 stops the app at boot, naming the key.
 */
export const NAME_CHECK_PER_HOUR_KEY = 'NAME_CHECK_PER_HOUR';
export const NAME_CHECK_PER_HOUR_LAUNCH = 30;
const NAME_CHECK_PER_HOUR_MAX = 1000;
export const NAME_CHECK_WINDOW_MS = 60 * 60_000;

/** A name check setting that is set but unusable. Stops the app at boot. */
export class NameCheckConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NameCheckConfigError';
  }
}

export function readNameCheckPerHour(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return NAME_CHECK_PER_HOUR_LAUNCH;
  }
  const text = raw.trim();
  // \d is the ASCII digits only.
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > NAME_CHECK_PER_HOUR_MAX) {
    throw new NameCheckConfigError(
      `${NAME_CHECK_PER_HOUR_KEY} must be a whole number from 1 to ${NAME_CHECK_PER_HOUR_MAX}, or left empty for ${NAME_CHECK_PER_HOUR_LAUNCH}.`,
    );
  }
  return n;
}

/** The sentence for a person past the limit: the wait in minutes, in plain words. */
export function nameCheckLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `You have checked a lot of accounts this hour. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * The per-person count of bank name checks: the shared fixed-window counter
 * (`PersonWindowLimiter`), one window of an hour that starts at the person's
 * first check in it, keyed by the verified wawuUserId and never by address
 * (two people on one address each keep their own count). An entry is made
 * only by `take`, which a controller calls after WawuAuthGuard verified the
 * token, so a forged or missing token never makes one.
 *
 * One budget covers every route that tells a person whose account a bank
 * number is: `POST /money/banks/name-check`, `PUT /money/payout-account` (its
 * refusal names the holder) and `POST /money/beneficiaries` for a bank
 * account. A bank send's own check just before the money goes is not counted:
 * sends to other people are unchanged (R-51).
 *
 * Counted and decided in memory in one step, so nothing is held while the
 * bank is asked: the count is taken, then the check runs holding nothing. A
 * check the bank could not answer (`provider_unreachable`) says nothing about
 * any account, so its place is given back.
 */
@Injectable()
export class NameCheckBudget extends PersonWindowLimiter {
  readonly perHour: number;

  constructor(config: ConfigService) {
    const perHour = readNameCheckPerHour(
      config.get<string>(NAME_CHECK_PER_HOUR_KEY),
    );
    super(
      [{ name: 'hour', limit: perHour, windowMs: NAME_CHECK_WINDOW_MS }],
      (retryAfterSeconds) =>
        new MoneyError(
          'name_check_rate_limited',
          nameCheckLimitMessage(retryAfterSeconds),
          { retryAfterSeconds },
        ),
    );
    this.perHour = perHour;
  }

  /**
   * Counts one check for this person (or refuses, with `Retry-After` set),
   * then runs it. Nothing is held while `check` runs.
   */
  async run<T>(
    wawuUserId: string,
    res: { set(name: string, value: string): unknown },
    check: () => Promise<T>,
  ): Promise<T> {
    let giveBack: () => void;
    try {
      giveBack = this.take(wawuUserId);
    } catch (e) {
      if (e instanceof MoneyError) {
        const seconds = (
          e.getResponse() as { reason?: { retryAfterSeconds?: number } }
        ).reason?.retryAfterSeconds;
        if (seconds !== undefined) res.set('Retry-After', String(seconds));
      }
      throw e;
    }
    try {
      return await check();
    } catch (e) {
      if (e instanceof MoneyError && e.code === 'provider_unreachable') {
        giveBack();
      }
      throw e;
    }
  }
}
