/**
 * THE HOLIDAYS A STORE EARNING'S WAITING DAYS SKIP (STORE-HOLIDAYS, R-101 point 4).
 *
 * A creator is paid 3 working days after a store sale. A working day is Monday
 * to Friday in Lagos and not a public holiday. The holidays are an admin plan
 * setting, `store.holidays`: dates (`YYYY-MM-DD`, Lagos), one per line, kept
 * lowest first. The seed holds Nigeria's FIXED public holidays for 2026 and
 * 2027; the days that move with the moon or the Church year (Eid, Good Friday,
 * Easter Monday, the Prophet's birthday) and a Monday given for a holiday on a
 * weekend are added by an admin each year.
 *
 * Pure: no database, no settings service. `StoreEarningService` reads the live
 * list and passes the set to `payableAt`.
 */

/** The setting that holds the holidays, as dates one per line. */
export const STORE_HOLIDAYS_KEY = 'store.holidays';

/** The most dates the list may hold. A checking limit, not a product figure. */
export const STORE_HOLIDAYS_MAX = 400;

/** Why a list is refused, in words that complete "<key> ...". */
export class HolidayListProblem extends Error {}

function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/**
 * Checks the dates an admin sends and returns the lines to store: each a real
 * calendar date written `YYYY-MM-DD`, from 2020 to 2100, each once, lowest
 * first (an out-of-order list is sorted, not refused: a person adding Eid to
 * the end of a list should not be sent back).
 */
export function parseHolidayLines(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > STORE_HOLIDAYS_MAX) {
    throw new HolidayListProblem(
      `must be a list of at most ${STORE_HOLIDAYS_MAX} dates, each written YYYY-MM-DD`,
    );
  }
  const seen = new Set<string>();
  for (const item of raw) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!isRealDate(text)) {
      throw new HolidayListProblem(
        'needs every date to be a real day written YYYY-MM-DD',
      );
    }
    const year = Number(text.slice(0, 4));
    if (year < 2020 || year > 2100) {
      throw new HolidayListProblem('needs every date to fall in 2020 to 2100');
    }
    if (seen.has(text)) {
      throw new HolidayListProblem(`lists ${text} more than once`);
    }
    seen.add(text);
  }
  return [...seen].sort();
}

/** The Lagos dates of a stored list, as the set `addWorkingDays` skips. */
export function holidaySet(lines: readonly string[]): ReadonlySet<string> {
  return new Set(lines);
}

/**
 * Nigeria's fixed public holidays for 2026 and 2027, as the seed
 * (`plan-settings.defaults.json`) holds them: New Year's Day, Workers' Day,
 * Democracy Day, Independence Day, Christmas Day and Boxing Day. A spec checks
 * the seed and this list agree.
 */
export const FIXED_HOLIDAYS_2026_2027: readonly string[] = [
  '2026-01-01',
  '2026-05-01',
  '2026-06-12',
  '2026-10-01',
  '2026-12-25',
  '2026-12-26',
  '2027-01-01',
  '2027-05-01',
  '2027-06-12',
  '2027-10-01',
  '2027-12-25',
  '2027-12-26',
];
