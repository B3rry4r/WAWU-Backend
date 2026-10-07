import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TgifDayView } from './tgif-day.type';

/** One day of the book, as `assets/tgif/MM.json` writes it. */
interface BookEntry {
  d: number;
  quote: string;
  ref: string;
  reality: string;
  remember: string;
  prayer: string;
  takeaway: string;
  series: string;
  seriesTheme: string;
  /** Only 31 December has one. Not served: no screen draws it. */
  outro?: string[];
}

interface BookMonth {
  month: number;
  days: BookEntry[];
}

/** Days in each month of the book. 29 February reads 28 February's entry. */
export const BOOK_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The env key that holds the link written on a shared card. */
export const TGIF_SHARE_LINK_KEY = 'TGIF_SHARE_LINK';

const TEXT_FIELDS = [
  'quote',
  'ref',
  'reality',
  'remember',
  'prayer',
  'takeaway',
  'series',
  'seriesTheme',
] as const;

/** The repo's root: the folder above this file that holds package.json (src/ in tests, dist/src/ when built). */
function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir)
      throw new Error('TGIF book: package.json not found above ' + __dirname);
    dir = up;
  }
  return dir;
}

const BOOK_DIR = join(repoRoot(), 'assets', 'tgif');

/** Reads one month of the book and refuses a file that is not shaped as the app needs. */
export function readBookMonth(month: number, dir = BOOK_DIR): BookMonth {
  const name = String(month).padStart(2, '0');
  const parsed = JSON.parse(
    readFileSync(join(dir, `${name}.json`), 'utf8'),
  ) as BookMonth;
  const expected = BOOK_DAYS[month - 1];
  if (parsed.month !== month || parsed.days.length !== expected) {
    throw new Error(`TGIF book ${name}.json is not month ${month} in full`);
  }
  parsed.days.forEach((entry, i) => {
    if (entry.d !== i + 1)
      throw new Error(`TGIF book ${name}.json: day ${i + 1} is out of order`);
    for (const field of TEXT_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '')
        throw new Error(`TGIF book ${name}.json day ${entry.d}: no ${field}`);
    }
  });
  return parsed;
}

/**
 * The part of a name a person is called by: the first word, with anything
 * that is not a letter, mark, digit, hyphen or apostrophe dropped, at most 40
 * characters. Null when nothing is left.
 */
export function callName(raw: string | null | undefined): string | null {
  const first = (raw ?? '').trim().split(/\s+/)[0] ?? '';
  const clean = [...first.replace(/[^\p{L}\p{M}\p{N}'’-]/gu, '')]
    .slice(0, 40)
    .join('');
  return clean === '' ? null : clean;
}

/**
 * Puts the reader's name where the book leaves a slot for it. The book is
 * written in the second person and marks each personal address `{Name}`. With
 * no name to use the sentence still has to read as English: "{Name}, your sins
 * are gone" becomes "Your sins are gone", never "friend, your sins are gone".
 */
export function personalise(text: string, firstName: string | null): string {
  if (firstName) return text.replaceAll('{Name}', () => firstName);
  return text
    .replaceAll(/\{Name\}, ([a-z])/g, (_m, c: string) => c.toUpperCase())
    .replaceAll('{Name}', 'you');
}

/** `YYYY-MM-DD` (already validated by TgifDatePipe) as the book's month and day. */
export function bookDay(date: string): { month: number; day: number } {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  // 29 February reads 28 February: the book is keyed to the date, so every
  // later date stays where it is in a leap year.
  return { month, day: month === 2 && day === 29 ? 28 : day };
}

function link(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return v === '' ? null : [...v].slice(0, 60).join('');
}

/**
 * The text of every TGIF day (task HOME-09, G-161). The book was written once
 * and ships with the server (`assets/tgif`, 365 days, a copy of the web app's
 * `public/tgif`), so a day is a lookup, with no table to migrate. Months are
 * read the first time they are asked for and kept.
 */
@Injectable()
export class TgifContentService {
  private readonly months = new Map<number, BookMonth>();

  constructor(private readonly config: ConfigService) {}

  private month(month: number): BookMonth {
    let hit = this.months.get(month);
    if (!hit) {
      hit = readBookMonth(month);
      this.months.set(month, hit);
    }
    return hit;
  }

  shareLink(): string | null {
    return link(this.config.get<string>(TGIF_SHARE_LINK_KEY));
  }

  /** The five cards of `date` for a caller called `firstName`. */
  day(date: string, firstName: string | null): TgifDayView {
    const at = bookDay(date);
    const entry = this.month(at.month).days[at.day - 1];
    const name = callName(firstName);
    return {
      date,
      series: entry.series,
      seriesTheme: entry.seriesTheme,
      verse: personalise(entry.quote, name),
      verseReference: entry.ref,
      reality: personalise(entry.reality, name),
      remember: personalise(entry.remember, name),
      prayer: personalise(entry.prayer, name),
      takeaway: personalise(entry.takeaway, name),
      shareLink: this.shareLink(),
    };
  }
}
