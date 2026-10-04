import { BadRequestException } from '@nestjs/common';

/**
 * Featured works and education (ME-16): the limits, the text rules and the
 * year rules, in one place so the DTOs, the services and the tests read the
 * same numbers.
 *
 * Nothing in DECISIONS.md or the design gives a length, a count or a year
 * range for any of these, so each limit is a named, provisional number the
 * owner may change.
 */

/** PROVISIONAL(WORKS-MAX-COUNT, owner=YOU, why=no document or ruling gives a limit; M34 draws 12). Most featured works on one profile. */
export const MAX_WORKS = 50;
/** PROVISIONAL(WORKS-MAX-MEDIA, owner=YOU, why=no document or ruling gives a limit; M35 draws a cover and a strip of 3). Most pictures or videos on one work. */
export const MAX_WORK_MEDIA = 8;
/** PROVISIONAL(EDUCATION-MAX-COUNT, owner=YOU, why=no document or ruling gives a limit; the experience list caps at 15). Most education entries on one profile. */
export const MAX_EDUCATION = 10;

/** PROVISIONAL(WORKS-TITLE-MAX, owner=YOU, why=no ruling names a limit; 120 copies ProfileExperience.title). */
export const WORK_TITLE_MAX = 120;
/** PROVISIONAL(WORKS-ROLE-MAX, owner=YOU, why=no ruling names a limit). */
export const WORK_ROLE_MAX = 80;
/** PROVISIONAL(WORKS-CLIENT-MAX, owner=YOU, why=no ruling names a limit; 120 copies ProfileExperience.company). */
export const WORK_CLIENT_MAX = 120;
/** PROVISIONAL(WORKS-CATEGORY-MAX, owner=YOU, why=no ruling names a limit; 40 copies the skills chips). */
export const WORK_CATEGORY_MAX = 40;
/** PROVISIONAL(WORKS-LINK-MAX, owner=YOU, why=no ruling names a limit). */
export const WORK_LINK_MAX = 300;
/** PROVISIONAL(WORKS-DESCRIPTION-MAX, owner=YOU, why=no ruling names a limit; 1000 copies ProfileExperience.description). */
export const WORK_DESCRIPTION_MAX = 1000;
/** PROVISIONAL(EDUCATION-SCHOOL-MAX, owner=YOU, why=no ruling names a limit; 120 copies ProfileExperience.company). */
export const EDUCATION_SCHOOL_MAX = 120;
/** PROVISIONAL(EDUCATION-FIELD-MAX, owner=YOU, why=no ruling names a limit; 120 copies ProfileExperience.title). */
export const EDUCATION_FIELD_MAX = 120;

/** PROVISIONAL(WORKS-FIRST-YEAR, owner=YOU, why=no ruling names a range). The earliest year a work or a course may start. */
export const FIRST_YEAR = 1950;

/**
 * The latest year a work may carry: this year and the next. Next year is
 * allowed because a phone in Lagos is an hour ahead of UTC and a New Year's
 * Eve entry would otherwise be refused for that hour.
 */
export function latestWorkYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/** PROVISIONAL(EDUCATION-END-AHEAD, owner=YOU, why=a course in progress ends in the years ahead; no ruling names how far). Years ahead an end year may be. */
export const EDUCATION_END_YEARS_AHEAD = 10;

/**
 * Control characters that have no place in a line of text: C0 (NUL, tab,
 * newline, escape), DEL, C1, the line and paragraph separators, and the
 * bidirectional overrides that make text read as something it is not.
 */
/* eslint-disable no-control-regex -- these ranges ARE the control characters being refused */
const SINGLE_LINE_FORBIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** The same, for a paragraph: a newline, a carriage return and a tab are allowed. */
const MULTI_LINE_FORBIDDEN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Whitespace, control characters, bidi overrides and the characters that open markup or quoting. */
const LINK_FORBIDDEN =
  /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069<>"'`\\]/;
/* eslint-enable no-control-regex */
/** A dotted host name of plain labels (the URL parser has already turned any non-ASCII into punycode). */
const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
/** The start of an HTML tag, comment or processing instruction. */
const TAG_START = /<[/!?a-zA-Z]/;

export const NO_MARKUP_MESSAGE = (field: string) =>
  `${field} cannot contain HTML tags`;

/**
 * Text as a person typed it, made safe to store and show: trimmed, an empty
 * answer is "nothing", and anything that is not plain text is a 400, not a
 * 500 from the database (Postgres refuses a NUL byte) and not a tag some
 * client may one day draw as markup. The text is stored exactly as typed
 * after the trim: it is plain text everywhere it is read.
 *
 * `multiline` lets a paragraph keep its line breaks (the description). A
 * single-line field also has its inner runs of spaces collapsed to one, so
 * "Brand   films" and "Brand films" are the same category.
 */
export function cleanText(
  raw: string,
  field: string,
  opts: { max: number; multiline?: boolean },
): string | null {
  const forbidden = opts.multiline
    ? MULTI_LINE_FORBIDDEN
    : SINGLE_LINE_FORBIDDEN;
  if (forbidden.test(raw)) {
    throw new BadRequestException(
      `${field} has a character that is not allowed`,
    );
  }
  if (TAG_START.test(raw)) {
    throw new BadRequestException(NO_MARKUP_MESSAGE(field));
  }
  let text = raw.trim();
  if (!opts.multiline) text = text.replace(/[ ]{2,}/g, ' ');
  if (text.length > opts.max) {
    throw new BadRequestException(
      `${field} can be at most ${opts.max} characters`,
    );
  }
  return text.length === 0 ? null : text;
}

/** `cleanText` for a field that must have something in it. */
export function requiredText(
  raw: string,
  field: string,
  opts: { max: number; multiline?: boolean },
): string {
  const text = cleanText(raw, field, opts);
  if (text === null) throw new BadRequestException(`${field} is required`);
  return text;
}

/**
 * A link, as typed. Accepts `https://...`, `http://...`, a bare site such as
 * `lennoxfilms.com/reel` (stored with `https://` in front) and a `wawu/...`
 * link (M36's hint). Anything with another scheme (`javascript:`, `data:`,
 * `file:`), embedded credentials, a space or a host with no dot is a 400.
 * The link is only ever stored and shown; the server never fetches it.
 */
export function cleanLink(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.length > WORK_LINK_MAX) {
    throw new BadRequestException(
      `Link can be at most ${WORK_LINK_MAX} characters`,
    );
  }
  const bad = () => new BadRequestException('Link is not a web address');
  if (LINK_FORBIDDEN.test(text)) {
    throw bad();
  }
  if (/^wawu\/[A-Za-z0-9._~\-/]+$/.test(text) && !text.includes('..')) {
    return text;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  const withScheme = hasScheme ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw bad();
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    !/^https?:\/\//i.test(withScheme) ||
    url.username !== '' ||
    url.password !== '' ||
    !HOSTNAME.test(url.hostname)
  ) {
    throw bad();
  }
  return withScheme;
}

/** A whole year inside [min, max], or a 400 that names the range. */
export function assertYear(
  value: number,
  field: string,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestException(
      `${field} must be a year from ${min} to ${max}`,
    );
  }
}

/** The kinds of file a work may carry, by the extension the presigner issues. */
export const WORK_MEDIA_EXTENSIONS = ['png', 'jpg', 'webp', 'mp4'] as const;

/**
 * Whether `key` is an object key of the grammar `presignUpload` writes
 * (`profile/work/<wawuId>/<uuid>.<ext>`) under THIS person's own prefix.
 * The same shape of check as `isOwnContentKey`.
 */
export function isOwnWorkKey(key: string, wawuId: string): boolean {
  if (key.includes('..') || key.includes('//')) return false;
  const parts = key.split('/');
  return (
    parts.length === 4 &&
    parts[0] === 'profile' &&
    parts[1] === 'work' &&
    parts[2] === wawuId &&
    /^[0-9a-f-]{36}\.(png|jpg|webp|mp4)$/.test(parts[3])
  );
}

/** What a picture or a video is, from its key's extension. */
export function workMediaKind(key: string): 'image' | 'video' {
  return key.endsWith('.mp4') ? 'video' : 'image';
}
