import type { ConfigService } from '@nestjs/config';
import { MoneyError } from '../../money-error';
import {
  NAME_CHECK_PER_HOUR_LAUNCH,
  NAME_CHECK_WINDOW_MS,
  NameCheckBudget,
  NameCheckConfigError,
  nameCheckLimitMessage,
  readNameCheckPerHour,
} from '../name-check-budget';

/**
 * The hourly count of bank name checks per person (WALLET-37, R-51, G-764):
 * the setting, the sentence, the window, and what a check that never reached
 * the bank does to the count.
 */

const config = (value?: string) =>
  ({ get: () => value }) as unknown as ConfigService;

function reasonOf(e: unknown) {
  expect(e).toBeInstanceOf(MoneyError);
  return (e as MoneyError).getResponse() as {
    reason: { code: string; message: string; retryAfterSeconds: number };
  };
}

describe('the name check setting', () => {
  it('is 30 at launch when nothing is set', () => {
    expect(NAME_CHECK_PER_HOUR_LAUNCH).toBe(30);
    expect(readNameCheckPerHour(undefined)).toBe(30);
    expect(readNameCheckPerHour('')).toBe(30);
    expect(new NameCheckBudget(config()).perHour).toBe(30);
  });

  it('takes a whole number from 1 to 1000 and stops the app on anything else', () => {
    expect(readNameCheckPerHour(' 45 ')).toBe(45);
    expect(readNameCheckPerHour('1')).toBe(1);
    for (const bad of ['0', '-3', '2.5', 'ten', '1001', '٣', '3e1']) {
      expect(() => readNameCheckPerHour(bad)).toThrow(NameCheckConfigError);
      expect(() => new NameCheckBudget(config(bad))).toThrow(
        /NAME_CHECK_PER_HOUR/,
      );
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
    const budget = new NameCheckBudget(config());
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
    const budget = new NameCheckBudget(config());
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
    const budget = new NameCheckBudget(config('2'));
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
