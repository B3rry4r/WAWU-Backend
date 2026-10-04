/**
 * Writing a statement's CSV (task WALLET-27): pure functions, so the rules
 * below are unit-tested on their own (statement-units.spec.ts).
 *
 * - RFC 4180: cells joined by commas, lines ending CRLF, a cell holding a
 *   comma, a quote or a line break wrapped in quotes with its quotes
 *   doubled.
 * - A byte-order mark first, so a spreadsheet opens the file as UTF-8 and
 *   shows the naira sign in the header.
 * - A text cell that a spreadsheet would run as a formula (it starts with
 *   `=`, `+`, `-`, `@`, a tab or a carriage return) is written with a `'`
 *   in front. Names and notes come from people; a statement never runs
 *   anything when it is opened.
 * - Amounts are naira with two decimals, written from integer kobo with
 *   integer arithmetic, never a float.
 */

export const CSV_BOM = '﻿';
export const CSV_EOL = '\r\n';

/** The header line's cells, in order. Naira only. */
export const STATEMENT_COLUMNS = [
  'Date',
  'Time',
  'Description',
  'Counterparty',
  'Reference',
  'Note',
  'Money in (₦)',
  'Money out (₦)',
  'Of which fees (₦)',
] as const;

/** Integer kobo as naira with two decimals: 125050 is "1250.50". */
export function nairaText(kobo: number): string {
  if (!Number.isSafeInteger(kobo) || kobo < 0) {
    throw new RangeError('A statement amount must be whole, positive kobo.');
  }
  const k = BigInt(kobo);
  return `${(k / 100n).toString()}.${(k % 100n).toString().padStart(2, '0')}`;
}

/** One cell of text: formula characters neutralised, quoted when it must be. */
export function textCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One line of cells, already written, with its CRLF. */
export function csvLine(cells: readonly string[]): string {
  return `${cells.join(',')}${CSV_EOL}`;
}

/** The header line. */
export function headerLine(): string {
  return csvLine(STATEMENT_COLUMNS.map((c) => textCell(c)));
}

/** One movement as the statement lists it. */
export interface StatementLine {
  /** YYYY-MM-DD, Africa/Lagos. */
  date: string;
  /** HH:MM, 24-hour, Africa/Lagos. */
  time: string;
  description: string;
  counterparty: string | null;
  reference: string;
  note: string | null;
  direction: 'in' | 'out';
  /** In: what arrived. Out: what left, fees included. */
  totalKobo: number;
  /** Out: the part of totalKobo that was fees. In: 0. */
  feeKobo: number;
}

export function movementLine(m: StatementLine): string {
  const money = (kobo: number) => nairaText(kobo);
  return csvLine([
    m.date,
    m.time,
    textCell(m.description),
    textCell(m.counterparty),
    textCell(m.reference),
    textCell(m.note),
    m.direction === 'in' ? money(m.totalKobo) : '',
    m.direction === 'out' ? money(m.totalKobo) : '',
    m.direction === 'out' ? money(m.feeKobo) : '',
  ]);
}

/* ------------------------------------------------------------------ */
/* Calendar days                                                       */
/* ------------------------------------------------------------------ */

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
export function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/**
 * A YYYY-MM-DD string as its day number, or null when it is not a day on
 * the calendar (2026-02-30, year 0000, which the database cannot hold).
 */
export function calendarDay(text: string): number | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return dayNumber(y, m, d);
}

/** Today's date in Africa/Lagos, YYYY-MM-DD. */
export function lagosToday(now: Date): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
