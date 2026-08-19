import { buildAvailability, CONSULTATION_HOURS } from '../availability';

/**
 * Slot generation is arithmetic over dates, which is exactly the kind of thing
 * that looks right and is off by an hour or a day.
 */
describe('consultation availability', () => {
  // A Wednesday.
  const now = new Date('2026-08-19T10:00:00.000Z');

  it('starts tomorrow, never today', () => {
    const days = buildAvailability(new Set(), now);
    expect(days[0].date).toBe('2026-08-20');
  });

  it('offers only weekdays', () => {
    for (const day of buildAvailability(new Set(), now)) {
      const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      expect(CONSULTATION_HOURS.weekdays).toContain(weekday);
    }
  });

  it('runs 09:00 to 16:00 Lagos time', () => {
    const [first] = buildAvailability(new Set(), now);
    // Lagos is UTC+1, so 09:00 local is 08:00Z.
    expect(first.slots[0].startsAt).toBe('2026-08-20T08:00:00.000Z');
    expect(first.slots.at(-1)!.startsAt).toBe('2026-08-20T15:00:00.000Z');
    expect(first.slots).toHaveLength(8);
  });

  it('marks a booked hour unavailable and leaves the rest alone', () => {
    const taken = new Set(['2026-08-20T08:00:00.000Z']);
    const [first] = buildAvailability(taken, now);
    expect(first.slots[0].available).toBe(false);
    expect(first.slots[1].available).toBe(true);
  });

  it('never returns a slot in the past', () => {
    for (const day of buildAvailability(new Set(), now)) {
      for (const slot of day.slots) {
        expect(new Date(slot.startsAt).getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });
});
