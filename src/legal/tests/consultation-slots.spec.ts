import { CONSULTATION_HOURS } from '../availability';
import {
  appointmentMinutes,
  buildSlotDays,
  isOfferedStart,
  overlaps,
} from '../consultation-slots';

/**
 * The arithmetic that sells, or refuses, an hour: a call is offered where it
 * fits the day and runs into nothing already held.
 */
describe('consultation slots by length', () => {
  // A Wednesday. Lagos is UTC+1, so 09:00 local is 08:00Z.
  const now = new Date('2026-08-19T10:00:00.000Z');
  const thursday = (hourLagos: number) =>
    new Date(Date.UTC(2026, 7, 20, hourLagos - 1, 0, 0, 0));

  it('lists every hourly start for a call of one hour or less', () => {
    for (const minutes of [20, 30, 60]) {
      const [first] = buildSlotDays([], minutes, now);
      expect(first.slots).toHaveLength(8);
      expect(first.slots[0].startsAt).toBe('2026-08-20T08:00:00.000Z');
      expect(first.slots.at(-1)!.startsAt).toBe('2026-08-20T15:00:00.000Z');
    }
  });

  it('drops the last start when a call would run past closing', () => {
    const [first] = buildSlotDays([], 90, now);
    // 16:00 + 90 minutes ends 17:30, after the 17:00 close.
    expect(first.slots.at(-1)!.startsAt).toBe('2026-08-20T14:00:00.000Z');
    expect(first.slots).toHaveLength(7);
  });

  it('offers nothing for a call longer than the working day', () => {
    expect(buildSlotDays([], 600, now)).toEqual([]);
  });

  it('blocks the hour a longer call runs into, and only that hour', () => {
    // A 90-minute call at 10:00 runs to 11:30.
    const held = [{ scheduledFor: thursday(10), minutes: 90 }];
    const [first] = buildSlotDays(held, 60, now);
    const free = (hour: number) =>
      first.slots.find((s) => s.startsAt === thursday(hour).toISOString())!
        .available;
    expect(free(9)).toBe(true);
    expect(free(10)).toBe(false);
    expect(free(11)).toBe(false);
    expect(free(12)).toBe(true);
  });

  it('lets a call that ends exactly where another starts sit beside it', () => {
    expect(overlaps(thursday(9), 60, thursday(10), 60)).toBe(false);
    expect(overlaps(thursday(9), 61, thursday(10), 60)).toBe(true);
  });

  it('reads a booking with no recorded length as one slot', () => {
    expect(
      appointmentMinutes({ scheduledFor: thursday(10), minutes: null }),
    ).toBe(CONSULTATION_HOURS.slotMinutes);
    const [first] = buildSlotDays(
      [{ scheduledFor: thursday(10), minutes: null }],
      30,
      now,
    );
    expect(
      first.slots.filter((s) => !s.available).map((s) => s.startsAt),
    ).toEqual([thursday(10).toISOString()]);
  });

  it('knows which starts the calendar offers', () => {
    expect(isOfferedStart(thursday(9), 60, now)).toBe(true);
    expect(isOfferedStart(thursday(16), 60, now)).toBe(true);
    expect(isOfferedStart(thursday(16), 90, now)).toBe(false);
    // Not on the hour, before opening, a weekend, and the past.
    expect(isOfferedStart(new Date('2026-08-20T09:30:00.000Z'), 60, now)).toBe(
      false,
    );
    expect(isOfferedStart(thursday(8), 60, now)).toBe(false);
    expect(isOfferedStart(new Date('2026-08-22T09:00:00.000Z'), 60, now)).toBe(
      false,
    );
    expect(isOfferedStart(new Date('2026-08-19T08:00:00.000Z'), 60, now)).toBe(
      false,
    );
  });
});
