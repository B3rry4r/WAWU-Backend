import { upgradeActiveUntil } from '../tier-grant.service';

/**
 * TIER-UPGRADE-FIX: the end an upgrade sets is the later of the end already
 * held and now plus the new tier's days. Pure; no database.
 */
const DAY = 86_400_000;
const now = new Date('2026-11-09T10:00:00.000Z');

describe('upgradeActiveUntil (TIER-UPGRADE-FIX)', () => {
  it('keeps a held end that is later than the new tier days (a renewal was paid)', () => {
    const held = new Date(now.getTime() + 700 * DAY);
    expect(upgradeActiveUntil(held, now, 365)).toEqual(held);
  });

  it('gives now plus the new tier days when no renewal made the held end later', () => {
    const held = new Date(now.getTime() + 300 * DAY);
    expect(upgradeActiveUntil(held, now, 365).getTime()).toBe(
      now.getTime() + 365 * DAY,
    );
  });

  it('never ends earlier than the held end', () => {
    for (const left of [1, 100, 365, 366, 730]) {
      const held = new Date(now.getTime() + left * DAY);
      expect(
        upgradeActiveUntil(held, now, 365).getTime(),
      ).toBeGreaterThanOrEqual(held.getTime());
    }
  });
});
