import { clockWithRoomInLagosDay } from '../../../../test/payments/wallet-pay-harness';
import { lagosDay } from '../earning-rules';

/**
 * FIX-61. The pay harness sweeps at its own clock, which runs ahead of the
 * wall clock by every pass a spec made, so a spec about ONE Lagos day (R-55)
 * could find Lagos midnight (23:00 UTC) between its own passes, and failed
 * for ten minutes of every day. `keepInLagosDay` is what pins it; this is its
 * rule, on both sides of midnight, with no database.
 */

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

describe('The pay harness keeps a spec inside one Lagos day (FIX-61)', () => {
  it('leaves the clock alone while two hours of the Lagos day are left', () => {
    for (const t of [
      '2026-10-17T00:00:00.000Z', // 01:00 in Lagos
      '2026-10-17T10:00:00.000Z',
      '2026-10-17T20:59:59.999Z', // 2 hours and 1 ms to midnight
      '2026-10-17T21:00:00.000Z', // exactly 2 hours to midnight
    ]) {
      expect(iso(clockWithRoomInLagosDay(at(t)))).toBe(t);
    }
  });

  it('moves it to the first instant of the next Lagos day when less is left', () => {
    for (const t of [
      '2026-10-17T21:00:00.001Z',
      '2026-10-17T22:13:00.000Z', // the minute CI failed at
      '2026-10-17T22:59:59.999Z', // the last millisecond before midnight
    ]) {
      const moved = clockWithRoomInLagosDay(at(t));
      expect(iso(moved)).toBe('2026-10-17T23:00:00.000Z');
      expect(lagosDay(new Date(moved)).key).toBe('2026-10-18');
    }
  });

  it('is on the safe side just after midnight: a new day has all its hours', () => {
    for (const t of ['2026-10-17T23:00:00.000Z', '2026-10-17T23:01:00.000Z']) {
      expect(iso(clockWithRoomInLagosDay(at(t)))).toBe(t);
    }
  });

  it('never moves the clock back, and always leaves the asked hours', () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      const from = at('2026-10-17T00:00:00.000Z') + m * 60_000;
      for (const hours of [0, 1, 2, 5]) {
        const to = clockWithRoomInLagosDay(from, hours);
        expect(to).toBeGreaterThanOrEqual(from);
        expect(
          lagosDay(new Date(to)).end.getTime() - to,
        ).toBeGreaterThanOrEqual(hours * HOUR);
      }
    }
  });

  it('asking for no hours never moves it', () => {
    const from = at('2026-10-17T22:59:59.999Z');
    expect(clockWithRoomInLagosDay(from, 0)).toBe(from);
  });
});
