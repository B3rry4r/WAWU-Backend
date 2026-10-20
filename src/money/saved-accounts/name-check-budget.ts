import { Injectable } from '@nestjs/common';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { MoneyError } from '../money-error';
import { PersonWindowLimiter } from '../person-window-limiter';

/**
 * How many bank name checks one signed-in person may make in an hour (task
 * WALLET-37; R-51, G-764: "a person can run at most 30 bank name checks an
 * hour; the number is a setting").
 *
 * The figure is the admin setting `name_check_per_hour` (launch value 30, in
 * src/plan-settings/plan-settings.defaults.json), a whole number from 1 to
 * 1,000. It is read from the registry on every check (HOME-17), so an admin's
 * edit applies to the next check with no restart. The environment key
 * `NAME_CHECK_PER_HOUR` that WALLET-37 read is retired: nothing reads it.
 */
export const NAME_CHECK_PER_HOUR_SETTING = 'name_check_per_hour';
export const NAME_CHECK_WINDOW_MS = 60 * 60_000;

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
 * account. A bank send to an account that is not saved, with no name token
 * this person got for that account, is a counted check like any other (WALLET-37
 * round 5, G-764); a send with such a token, or to a saved account, is the
 * send's own check and is not counted (R-51).
 *
 * Counted and decided in memory in one step, so nothing is held while the
 * bank is asked: the count is taken, then the check runs holding nothing. A
 * check the bank could not answer (`provider_unreachable`) says nothing about
 * any account, so its place is given back.
 */
@Injectable()
export class NameCheckBudget extends PersonWindowLimiter {
  constructor(private readonly settings: PlanSettingsService) {
    super(
      [
        {
          name: 'hour',
          // Read at every check, so an edit in admin applies at once.
          get limit(): number {
            return settings.number(NAME_CHECK_PER_HOUR_SETTING);
          },
          windowMs: NAME_CHECK_WINDOW_MS,
        },
      ],
      (retryAfterSeconds) =>
        new MoneyError(
          'name_check_rate_limited',
          nameCheckLimitMessage(retryAfterSeconds),
          { retryAfterSeconds },
        ),
    );
  }

  /** The checks one person may make in an hour right now. */
  get perHour(): number {
    return this.settings.number(NAME_CHECK_PER_HOUR_SETTING);
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
