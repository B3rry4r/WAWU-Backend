import { BadRequestException } from '@nestjs/common';
import { isCleanText } from '../admin/legal-documents/policy-input';
import { SCHOOL_LIMITS } from './school-admin.dto';

/**
 * The `GET /schools` cursor: an opaque position, base64url (no padding) of
 * the JSON `["<name>","<id>"]` of the last row a page gave.
 *
 * Every name the admin route accepts must give a cursor this list accepts
 * (SCHOOLS-04 round 3, D2), so both bounds below come from the admin's name
 * rule and nothing else. That rule (SCHOOLS-02, `CreateSchoolDto.name` and
 * `UpdateSchoolDto.name`) is: trimmed, `isCleanText` (no NUL, no lone
 * surrogate; every other control character is allowed), and
 * `@MaxLength(SCHOOL_LIMITS.name)`. class-validator counts that length with
 * validator's `isLength`: the UTF-16 length, less one for each surrogate
 * pair, less one for each variation selector (U+FE0E, U+FE0F) that follows a
 * code unit that is not one. So ONE counted character is at worst:
 *
 * - 3 UTF-16 units: a surrogate pair plus a variation selector, as in the
 *   white flag emoji (U+1F3F3 U+FE0F). Nothing longer counts as one: a second
 *   selector in a row counts on its own, and every pair or selector that is
 *   discounted needs a unit of its own beside it.
 * - 9 bytes of JSON in UTF-8: a control character, which JSON writes as a
 *   six-byte escape (U+0001 becomes the six characters backslash, u, 0, 0,
 *   0, 1), plus a variation selector (3 bytes). For comparison: a surrogate
 *   pair plus a selector is 7 bytes, a quote or a backslash 2 (escaped), any
 *   other character at most 4 (a pair) or 3 (one BMP unit).
 *
 * (Checked exhaustively for every string of up to six pieces drawn from a
 * letter, a control character, a quote, a backslash, both selectors, a flag,
 * a Han character, U+2028, a tab, an accented letter, a joiner and a
 * combining mark: none is worse. SCHOOLS-04 round 3 report.)
 *
 * Worst case at the admin's 120: a name of 360 UTF-16 units, and a JSON name
 * of 1080 bytes; the cursor's JSON adds 2 + 3 + 36 (the id) + 2 = 43 bytes,
 * 1123 in all, which base64url writes in 1498 characters. A cursor longer
 * than that, or a name longer than 360 units, is one this server never gave.
 */
const UNITS_PER_COUNTED_CHAR = 3;
const JSON_BYTES_PER_COUNTED_CHAR = 9;
const UUID_LENGTH = 36;
/** `["`, `","` and `"]` around the name and the id. */
const CURSOR_JSON_FRAME_BYTES = 2 + 3 + 2;

/** Longest name a cursor can carry, in UTF-16 units (360). */
export const CURSOR_NAME_MAX_UNITS =
  SCHOOL_LIMITS.name * UNITS_PER_COUNTED_CHAR;

const CURSOR_JSON_MAX_BYTES =
  SCHOOL_LIMITS.name * JSON_BYTES_PER_COUNTED_CHAR +
  UUID_LENGTH +
  CURSOR_JSON_FRAME_BYTES;

/** Longest cursor this server gives out, in characters (1498). */
export const CURSOR_MAX_LENGTH = Math.ceil((CURSOR_JSON_MAX_BYTES * 4) / 3);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(row: { name: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.name, row.id]), 'utf8').toString(
    'base64url',
  );
}

/** A cursor this server did not give out (or altered) is a 400, never a 500. */
export function decodeCursor(cursor: string): { name: string; id: string } {
  const bad = () =>
    new BadRequestException('cursor is not one this server gave out');
  if (cursor.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw bad();
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    typeof v[0] !== 'string' ||
    typeof v[1] !== 'string' ||
    v[0].length > CURSOR_NAME_MAX_UNITS ||
    !isCleanText(v[0]) ||
    !UUID_RE.test(v[1])
  )
    throw bad();
  const name = v[0];
  const id = v[1].toLowerCase();
  // Only the exact text this server writes: no spaces, no escapes it would
  // not use, no upper-case id, no padding.
  if (encodeCursor({ name, id }) !== cursor) throw bad();
  return { name, id };
}
