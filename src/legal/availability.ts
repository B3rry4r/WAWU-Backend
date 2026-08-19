/**
 * When a lawyer can actually see you.
 *
 * Consultations used to be booked with no time attached: you paid, and then
 * waited to be contacted. That gave the client no idea whether "within days"
 * meant tomorrow or next week, and gave WAWU no way to stop two people paying
 * for the same hour.
 *
 * Availability is generated rather than stored, because there is no rota
 * system yet: weekdays only, on the hour, inside working hours, from tomorrow
 * so nobody books a slot that has already started. Slots already taken by a
 * paid consultation are removed. When a real rota exists this is the one place
 * that has to change.
 */
export const CONSULTATION_HOURS = {
  /** Africa/Lagos. The whole practice sits in one timezone. */
  timeZone: 'Africa/Lagos',
  /** 09:00 to 16:00 inclusive, so the last consultation ends by 17:00. */
  firstHour: 9,
  lastHour: 16,
  /** Monday to Friday. */
  weekdays: [1, 2, 3, 4, 5],
  /** How far ahead the calendar runs. */
  horizonDays: 21,
  /** Physical consultations are arranged by email, so they book no slot. */
  slotMinutes: 60,
} as const;

export interface DayAvailability {
  /** YYYY-MM-DD. */
  date: string;
  slots: { startsAt: string; available: boolean }[];
}

/**
 * Builds the calendar. `taken` is the set of ISO timestamps already booked.
 *
 * Lagos is UTC+1 year-round with no daylight saving, so the offset is a
 * constant rather than something that needs a timezone library.
 */
export function buildAvailability(
  taken: Set<string>,
  now: Date,
): DayAvailability[] {
  const LAGOS_OFFSET_HOURS = 1;
  const days: DayAvailability[] = [];

  for (let dayOffset = 1; dayOffset <= CONSULTATION_HOURS.horizonDays; dayOffset++) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() + dayOffset);

    const weekday = day.getUTCDay();
    if (!(CONSULTATION_HOURS.weekdays as readonly number[]).includes(weekday)) {
      continue;
    }

    const slots: DayAvailability['slots'] = [];
    for (let hour = CONSULTATION_HOURS.firstHour; hour <= CONSULTATION_HOURS.lastHour; hour++) {
      const startsAt = new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          hour - LAGOS_OFFSET_HOURS,
          0,
          0,
          0,
        ),
      );
      const iso = startsAt.toISOString();
      slots.push({ startsAt: iso, available: !taken.has(iso) });
    }

    days.push({
      date: `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`,
      slots,
    });
  }

  return days;
}
