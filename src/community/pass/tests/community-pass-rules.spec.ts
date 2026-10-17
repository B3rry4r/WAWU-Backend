import {
  DEFAULT_PASS_MAX_KOBO,
  DEFAULT_PASS_MIN_KOBO,
  nextPassPeriod,
  PASS_PERIOD_DAYS,
  PASS_REMINDER_DAYS,
  passDaysFromTerms,
  passIsActive,
  passPriceBounds,
  passPriceProblem,
  reminderWindowEnd,
} from '../community-pass-rules';

const DAY = 86_400_000;
const NOW = new Date('2026-11-01T10:00:00.000Z');

describe('a private community pass: the rules (INBOX-24, R-63)', () => {
  it('runs 30 days from today when the person has no pass, or theirs has ended', () => {
    expect(PASS_PERIOD_DAYS).toBe(30);
    for (const end of [null, new Date(NOW.getTime() - 1), NOW]) {
      const p = nextPassPeriod(NOW, end);
      expect(p.startsAt).toEqual(NOW);
      expect(p.endsAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
    }
  });

  it('extends from the current end date when paid before the end', () => {
    const end = new Date(NOW.getTime() + 5 * DAY);
    const p = nextPassPeriod(NOW, end);
    expect(p.startsAt).toEqual(end);
    expect(p.endsAt.getTime()).toBe(end.getTime() + 30 * DAY);
    // Paying again chains: 60 days from today in all.
    const again = nextPassPeriod(NOW, p.endsAt);
    expect(again.endsAt.getTime()).toBe(NOW.getTime() + 65 * DAY);
  });

  it('is active until the end moment and not at it', () => {
    expect(passIsActive(null, NOW)).toBe(false);
    expect(passIsActive(new Date(NOW.getTime() + 1), NOW)).toBe(true);
    expect(passIsActive(NOW, NOW)).toBe(false);
  });

  it('reminds 3 days before the end', () => {
    expect(PASS_REMINDER_DAYS).toBe(3);
    expect(reminderWindowEnd(NOW).getTime()).toBe(NOW.getTime() + 3 * DAY);
  });

  it('takes the host price within the bounds, in whole kobo, and says why otherwise', () => {
    const b = passPriceBounds({});
    expect(b).toEqual({
      minKobo: DEFAULT_PASS_MIN_KOBO,
      maxKobo: DEFAULT_PASS_MAX_KOBO,
    });
    expect(passPriceProblem(200_000, b)).toBeNull();
    expect(passPriceProblem(0, b)).toMatch(/above zero/);
    expect(passPriceProblem(1.5, b)).toMatch(/above zero/);
    expect(passPriceProblem(DEFAULT_PASS_MIN_KOBO - 1, b)).toMatch(/at least/);
    expect(passPriceProblem(DEFAULT_PASS_MAX_KOBO + 1, b)).toMatch(/at most/);
    expect(
      passPriceBounds({
        COMMUNITY_PASS_MIN_KOBO: '50000',
        COMMUNITY_PASS_MAX_KOBO: '60000',
      }),
    ).toEqual({ minKobo: 50_000, maxKobo: 60_000 });
    // A bad setting falls back; a max under the min is lifted to the min.
    expect(passPriceBounds({ COMMUNITY_PASS_MIN_KOBO: 'x' }).minKobo).toBe(
      DEFAULT_PASS_MIN_KOBO,
    );
    expect(
      passPriceBounds({
        COMMUNITY_PASS_MIN_KOBO: '90000',
        COMMUNITY_PASS_MAX_KOBO: '1000',
      }).maxKobo,
    ).toBe(90_000);
    // A person reads these: the naira sign, never the letter N (INBOX-24 round 2).
    expect(passPriceProblem(DEFAULT_PASS_MIN_KOBO - 1, b)).toBe(
      'The monthly price must be at least ₦100.',
    );
    expect(passPriceProblem(DEFAULT_PASS_MAX_KOBO + 1, b)).toBe(
      'The monthly price can be at most ₦500,000.',
    );
    for (const m of [
      passPriceProblem(0, b),
      passPriceProblem(1, b),
      passPriceProblem(DEFAULT_PASS_MAX_KOBO + 1, b),
    ])
      expect(m).not.toContain('—');
  });

  it('reads the days a payment was quoted with, 30 when it has none', () => {
    expect(passDaysFromTerms({ periodDays: 30 })).toBe(30);
    expect(passDaysFromTerms({ periodDays: 7 })).toBe(7);
    expect(passDaysFromTerms(undefined)).toBe(30);
    expect(passDaysFromTerms({ periodDays: 'x' })).toBe(30);
    expect(passDaysFromTerms({ periodDays: -3 })).toBe(30);
  });
});
