import {
  CONSULTATION_HOURS,
  buildAvailability,
  type DayAvailability,
} from './availability';

/**
 * Consultation calendar maths for LEGAL-03: a slot is free only if a call of
 * the length being booked fits there and runs into no appointment already held.
 *
 * Kept free of the database so the arithmetic that sells (or refuses) an hour
 * can be tested on its own. The grid itself, its hours and its horizon still
 * come from `availability.ts`.
 */

/** An appointment that is holding part of the calendar. */
export interface HeldAppointment {
  scheduledFor: Date;
  /** Null on a booking made before lengths were recorded: one slot. */
  minutes: number | null;
}

const MINUTE_MS = 60_000;

/** Lagos is UTC+1 all year, with no daylight saving. */
const LAGOS_OFFSET_HOURS = 1;

export function appointmentMinutes(held: HeldAppointment): number {
  return held.minutes ?? CONSULTATION_HOURS.slotMinutes;
}

/** Whether two appointments share any minute. Touching ends do not overlap. */
export function overlaps(
  aStart: Date,
  aMinutes: number,
  bStart: Date,
  bMinutes: number,
): boolean {
  const aEnd = aStart.getTime() + aMinutes * MINUTE_MS;
  const bEnd = bStart.getTime() + bMinutes * MINUTE_MS;
  return aStart.getTime() < bEnd && bStart.getTime() < aEnd;
}

/**
 * The moment the working day ends on a calendar date (YYYY-MM-DD, Lagos).
 * The last slot starts at `lastHour` and the day closes an hour after it.
 */
function closingTime(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(
    y,
    m - 1,
    d,
    CONSULTATION_HOURS.lastHour + 1 - LAGOS_OFFSET_HOURS,
    0,
    0,
    0,
  );
}

/**
 * The calendar for a call of `minutes`.
 *
 * A start is listed only when the call ends by closing time, so a long call
 * is never offered at the end of the day. A listed start is `available` unless
 * it would run into a held appointment.
 */
export function buildSlotDays(
  held: HeldAppointment[],
  minutes: number,
  now: Date,
): DayAvailability[] {
  const days: DayAvailability[] = [];
  for (const day of buildAvailability(new Set(), now)) {
    const closes = closingTime(day.date);
    const slots = day.slots
      .filter(
        (slot) => new Date(slot.startsAt).getTime() + minutes * MINUTE_MS <= closes,
      )
      .map((slot) => {
        const start = new Date(slot.startsAt);
        const clash = held.some((h) =>
          overlaps(start, minutes, h.scheduledFor, appointmentMinutes(h)),
        );
        return { startsAt: slot.startsAt, available: !clash };
      });
    if (slots.length > 0) days.push({ date: day.date, slots });
  }
  return days;
}

/** Whether `start` is one of the starts the calendar offers for a call of `minutes`. */
export function isOfferedStart(start: Date, minutes: number, now: Date): boolean {
  const iso = start.toISOString();
  return buildSlotDays([], minutes, now).some((day) =>
    day.slots.some((slot) => slot.startsAt === iso),
  );
}
