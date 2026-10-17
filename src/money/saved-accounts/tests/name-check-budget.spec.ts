import type { PlanSettingsService } from '../../../plan-settings/plan-settings.service';
import { MoneyError } from '../../money-error';
import {
  NAME_CHECK_PER_HOUR_SETTING,
  NAME_CHECK_WINDOW_MS,
  NameCheckBudget,
  nameCheckLimitMessage,
} from '../name-check-budget';

/**
 * The hourly count of bank name checks per person (WALLET-37, R-51, G-764):
 * the setting, the sentence, the window, and what a check that never reached
 * the bank does to the count.
 */

/**
 * The admin settings, as far as the budget reads them: `number(key)`. The
 * registry itself (the 30, the 1 to 1,000 check, the live edit) is covered
 * against a real database in home-17-settings.contract.spec.ts.
 */
const settings = (value = 30) => {
  const held = { value };
  const stub = {
    number: (key: string) => {
      expect(key).toBe(NAME_CHECK_PER_HOUR_SETTING);
      return held.value;
    },
  } as unknown as PlanSettingsService;
  return Object.assign(stub, { held });
};

function reasonOf(e: unknown) {
  expect(e).toBeInstanceOf(MoneyError);
  return (e as MoneyError).getResponse() as {
    reason: { code: string; message: string; retryAfterSeconds: number };
  };
}

describe('the name check setting', () => {
  it('is read from the setting named name_check_per_hour, on every check', async () => {
    expect(NAME_CHECK_PER_HOUR_SETTING).toBe('name_check_per_hour');
    const s = settings(2);
    const budget = new NameCheckBudget(s);
    expect(budget.perHour).toBe(2);
    const quiet = { set: () => undefined };
    const run = () => budget.run('ada', quiet, () => Promise.resolve(1));
    await run();
    await run();
    await expect(run()).rejects.toMatchObject({ status: 429 });
    // An edit applies to the very next check, with no new budget built.
    s.held.value = 3;
    expect(budget.perHour).toBe(3);
    await run();
    await expect(run()).rejects.toMatchObject({ status: 429 });
    s.held.value = 1;
    await expect(run()).rejects.toMatchObject({ status: 429 });
  });

  it('does not read the retired environment key', () => {
    process.env.NAME_CHECK_PER_HOUR = '1';
    try {
      expect(new NameCheckBudget(settings(30)).perHour).toBe(30);
    } finally {
      delete process.env.NAME_CHECK_PER_HOUR;
    }
  });
});

describe('the sentence past the limit', () => {
  it('names the minutes left in plain words, rounded up, with no dash', () => {
    expect(nameCheckLimitMessage(1)).toBe(
      'You have checked a lot of accounts this hour. Try again in 1 minute.',
    );
    expect(nameCheckLimitMessage(60)).toBe(
      'You have checked a lot of accounts this hour. Try again in 1 minute.',
    );
    expect(nameCheckLimitMessage(61)).toContain('in 2 minutes.');
    expect(nameCheckLimitMessage(3600)).toContain('in 60 minutes.');
    expect(nameCheckLimitMessage(1234)).not.toContain('—');
  });
});

describe('NameCheckBudget', () => {
  const res = () => {
    const headers: Record<string, string> = {};
    return { headers, set: (k: string, v: string) => (headers[k] = v) };
  };

  it('allows exactly the limit an hour for one person and refuses the next with the wait', async () => {
    const budget = new NameCheckBudget(settings());
    let now = 1_000_000;
    budget.now = () => now;
    const out = res();
    let made = 0;
    for (let i = 0; i < 30; i += 1) {
      await budget.run('ada', out, () => Promise.resolve(++made));
    }
    now += 10 * 60_000;
    await expect(
      budget.run('ada', out, () => Promise.resolve(++made)),
    ).rejects.toMatchObject({ status: 429 });
    expect(made).toBe(30);
    const e = await budget
      .run('ada', out, () => Promise.resolve(++made))
      .catch((x: unknown) => x);
    expect(reasonOf(e).reason).toMatchObject({
      code: 'name_check_rate_limited',
      retryAfterSeconds: 50 * 60,
      message: expect.stringContaining('in 50 minutes.') as string,
    });
    expect(out.headers['Retry-After']).toBe(String(50 * 60));
    // Another person has all of their own; the first has theirs back after the hour.
    await budget.run('simi', out, () => Promise.resolve(++made));
    now += 50 * 60_000;
    await budget.run('ada', out, () => Promise.resolve(++made));
    expect(made).toBe(32);
    expect(NAME_CHECK_WINDOW_MS).toBe(3_600_000);
  });

  it('holds 20 checks at once to the same count: 30 of 45 run, the rest are refused, none are held', async () => {
    const budget = new NameCheckBudget(settings());
    let running = 0;
    let top = 0;
    let made = 0;
    const slow = async () => {
      running += 1;
      top = Math.max(top, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return ++made;
    };
    const results = await Promise.allSettled(
      Array.from({ length: 45 }, () => budget.run('ada', res(), slow)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(30);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(15);
    expect(made).toBe(30);
    // The count was decided before any check ran, so the refused ones never waited on the slow ones.
    expect(top).toBe(30);
  });

  it('gives the place back for a check the bank could not answer, and only for that', async () => {
    const budget = new NameCheckBudget(settings(2));
    const unreachable = () =>
      Promise.reject(new MoneyError('provider_unreachable', 'Try again.'));
    const notFound = () =>
      Promise.reject(new MoneyError('name_check_failed', 'No such account.'));
    await expect(budget.run('ada', res(), unreachable)).rejects.toMatchObject({
      status: 503,
    });
    await expect(budget.run('ada', res(), unreachable)).rejects.toMatchObject({
      status: 503,
    });
    await expect(budget.run('ada', res(), unreachable)).rejects.toMatchObject({
      status: 503,
    });
    // Two checks the bank answered, even with "no such account", use the two places.
    await expect(budget.run('ada', res(), notFound)).rejects.toMatchObject({
      status: 422,
    });
    await expect(budget.run('ada', res(), notFound)).rejects.toMatchObject({
      status: 422,
    });
    await expect(budget.run('ada', res(), notFound)).rejects.toMatchObject({
      status: 429,
    });
  });
});
