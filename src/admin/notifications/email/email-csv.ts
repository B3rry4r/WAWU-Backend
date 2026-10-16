/**
 * Reads an uploaded audience CSV (EMAIL-01): a header row with `email` and an
 * optional `first_name`; any other column is ignored. Addresses are trimmed
 * and lower-cased, bad ones counted, repeats dropped (the first row wins).
 */

export interface CsvPerson {
  email: string;
  firstName: string | null;
}

export interface CsvParseResult {
  people: CsvPerson[];
  invalid: number;
  duplicates: number;
  rows: number;
}

export class CsvFormatError extends Error {}

const EMAIL = /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]"]{2,}$/;

export function isValidEmail(s: string): boolean {
  return s.length <= 254 && EMAIL.test(s);
}

/** RFC 4180 style: quoted cells may hold commas, quotes ("") and new lines. */
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

export function parseAudienceCsv(text: string): CsvParseResult {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new CsvFormatError('The file is empty.');
  const header = rows[0].map(norm);
  const emailAt = header.findIndex(
    (h) => h === 'email' || h === 'email_address',
  );
  if (emailAt < 0) {
    throw new CsvFormatError('The first row must have a column named email.');
  }
  const nameAt = header.findIndex(
    (h) => h === 'first_name' || h === 'firstname',
  );
  const people: CsvPerson[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  for (const row of rows.slice(1)) {
    const email = (row[emailAt] ?? '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      invalid += 1;
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);
    const first = nameAt >= 0 ? (row[nameAt] ?? '').trim().slice(0, 80) : '';
    people.push({ email, firstName: first || null });
  }
  return { people, invalid, duplicates, rows: rows.length - 1 };
}
