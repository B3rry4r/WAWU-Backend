/**
 * Where a daily and a monthly limit start counting (task NUV-07): the
 * calendar day and the calendar month in Africa/Lagos, the time Nigerians
 * live by and the one statements use (WALLET-27). Default (agent), owner may
 * override: Nuvion does not say where its own day boundary falls.
 *
 * Read from the time zone database rather than a written offset.
 */
const LAGOS = 'Africa/Lagos';

const DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: LAGOS,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

/** The wall clock in Lagos at `at`, as numbers. */
function lagosClock(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const out: Record<string, number> = {};
  for (const part of DATE_PARTS.formatToParts(at)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** The instant the Lagos wall clock reads `year-month-day 00:00:00`. */
function lagosMidnight(year: number, month: number, day: number): Date {
  const asIfUtc = Date.UTC(year, month - 1, day);
  const c = lagosClock(new Date(asIfUtc));
  const shownAsIfUtc = Date.UTC(
    c.year,
    c.month - 1,
    c.day,
    c.hour,
    c.minute,
    c.second,
  );
  return new Date(asIfUtc - (shownAsIfUtc - asIfUtc));
}

/** When today, in Lagos, began. */
export function lagosDayStart(now: Date): Date {
  const c = lagosClock(now);
  return lagosMidnight(c.year, c.month, c.day);
}

/** When this month, in Lagos, began. */
export function lagosMonthStart(now: Date): Date {
  const c = lagosClock(now);
  return lagosMidnight(c.year, c.month, 1);
}
