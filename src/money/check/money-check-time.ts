/**
 * Lagos dates and clock times for the nightly check (task MONEY-16): the
 * night a run belongs to is a calendar date in Africa/Lagos, the time Nigerians
 * live by, read from the time zone database and never from a written offset.
 */
const LAGOS = 'Africa/Lagos';

const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: LAGOS,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function clock(at: Date): {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
} {
  const out: Record<string, string> = {};
  for (const part of PARTS.formatToParts(at)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: Number(out.hour),
    minute: Number(out.minute),
  };
}

/** The Lagos calendar date at `at`, as `YYYY-MM-DD`. */
export function lagosNight(at: Date): string {
  const c = clock(at);
  return `${c.year}-${c.month}-${c.day}`;
}

/** Minutes since Lagos midnight at `at`. */
export function lagosMinuteOfDay(at: Date): number {
  const c = clock(at);
  return c.hour * 60 + c.minute;
}

/** True for a string `lagosNight` could have made. */
export function isNight(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}
