import type { ConfigService } from '@nestjs/config';
import { FeeConfigError } from '../../fees/fee-config';
import { PaymentSettings } from '../../payments/payment-config';
import { lagosDay, moveReference } from '../earning-rules';

/**
 * The rules of the daily move that need no database (WALLET-16, R-55): what a
 * day is, what the provider is told the move is called, and the two settings.
 */

const settings = (env: Record<string, string>) =>
  new PaymentSettings({
    get: (k: string) => env[k],
  } as unknown as ConfigService);

describe('A day of money is a Lagos day (R-55)', () => {
  it('starts at Lagos midnight, which is 23:00 UTC the evening before', () => {
    const noon = lagosDay(new Date('2026-10-20T11:00:00Z')); // 12:00 in Lagos
    expect(noon.key).toBe('2026-10-20');
    expect(noon.start.toISOString()).toBe('2026-10-19T23:00:00.000Z');
    expect(noon.end.toISOString()).toBe('2026-10-20T23:00:00.000Z');
  });

  it('puts the last millisecond of a Lagos day in it and the next in the next', () => {
    const last = lagosDay(new Date('2026-10-20T22:59:59.999Z'));
    const first = lagosDay(new Date('2026-10-20T23:00:00.000Z'));
    expect(last.key).toBe('2026-10-20');
    expect(first.key).toBe('2026-10-21');
    expect(first.start.getTime()).toBe(last.end.getTime());
  });

  it('is the same day for every moment between its start and its end', () => {
    const day = lagosDay(new Date('2026-12-31T10:00:00Z'));
    expect(lagosDay(day.start).key).toBe(day.key);
    expect(lagosDay(new Date(day.end.getTime() - 1)).key).toBe(day.key);
    expect(day.end.getTime() - day.start.getTime()).toBe(86_400_000);
  });
});

describe('The move’s reference (R-55)', () => {
  const user = '3f2c7a52-91d4-4c3b-8a64-0e9f7b1d2c55';

  it('is built from the creator and the day alone, so any server builds the same one', () => {
    expect(moveReference(user, '2026-10-20', 1)).toBe(
      moveReference(user, '2026-10-20', 1),
    );
  });

  it('names the day, differs by creator, day and try, and fits Nuvion’s 64 characters', () => {
    const base = moveReference(user, '2026-10-20', 1);
    expect(base).toMatch(/^wawu-earn-d-20261020-[0-9a-f]{24}$/);
    expect(base).toHaveLength(45);
    expect(moveReference(user, '2026-10-21', 1)).not.toBe(base);
    expect(moveReference('another-creator', '2026-10-20', 1)).not.toBe(base);
    expect(moveReference(user, '2026-10-20', 2)).toBe(`${base}-2`);
    expect(moveReference(user, '2026-10-20', 12).length).toBeLessThanOrEqual(
      64,
    );
    // Even an id far longer than a uuid cannot push it past the provider's limit.
    expect(moveReference('x'.repeat(500), '2026-10-20', 99).length).toBe(48);
  });

  it('can never equal a sale’s own reference, wawu-earn-<payment id>', () => {
    const payment = '3f2c7a52-91d4-4c3b-8a64-0e9f7b1d2c55';
    expect(moveReference(user, '2026-10-20', 1)).not.toBe(
      `wawu-earn-${payment}`,
    );
    expect(
      moveReference(user, '2026-10-20', 1).startsWith('wawu-earn-d-'),
    ).toBe(true);
  });
});

describe('The two settings of the daily move (R-55)', () => {
  it('default to N200 and 72 hours', () => {
    const s = settings({});
    expect(s.earningsMoveMinKobo).toBe(20_000);
    expect(s.earningsRefusedReviewAfterHours).toBe(72);
  });

  it('take a whole number in range and stop the app on anything else', () => {
    const s = settings({
      EARNINGS_MOVE_MIN_KOBO: '50000',
      EARNINGS_REFUSED_REVIEW_AFTER_HOURS: '48',
    });
    expect(s.earningsMoveMinKobo).toBe(50_000);
    expect(s.earningsRefusedReviewAfterHours).toBe(48);
    expect(settings({ EARNINGS_MOVE_MIN_KOBO: '0' }).earningsMoveMinKobo).toBe(
      0,
    );
    for (const bad of ['-1', '200.5', 'two hundred', '100000001']) {
      expect(() => settings({ EARNINGS_MOVE_MIN_KOBO: bad })).toThrow(
        FeeConfigError,
      );
    }
    for (const bad of ['0', '721', '1.5', 'three days']) {
      expect(() =>
        settings({ EARNINGS_REFUSED_REVIEW_AFTER_HOURS: bad }),
      ).toThrow(FeeConfigError);
    }
  });
});
