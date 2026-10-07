import { BadRequestException } from '@nestjs/common';

/**
 * The opaque cursor every ME-10 list hands out and takes back
 * (docs/contract/CONVENTIONS.md section 6): where the last page stopped, as
 * that row's time and id, newest first. base64url JSON behind a prefix, so the
 * app can depend on nothing inside it, and checked strictly on the way back:
 * anything these lists did not write is a 400, never a query.
 */
export interface MeCursor {
  /** The last row's time, ISO 8601 UTC with milliseconds. */
  at: string;
  /** The last row's id. */
  id: string;
}

const PREFIX = 'm1.';
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Row ids are uuids; older seeded rows use the same form. */
const ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

export const BAD_ME_CURSOR = 'cursor is not one this list gave.';

export function encodeMeCursor(at: Date, id: string): string {
  const value: MeCursor = { at: at.toISOString(), id };
  return (
    PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  );
}

/** The cursor as a time and id, or undefined for a first page. */
export function decodeMeCursor(
  raw: string | undefined,
): { at: Date; id: string } | undefined {
  if (raw === undefined) return undefined;
  if (!raw.startsWith(PREFIX)) throw new BadRequestException(BAD_ME_CURSOR);
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw new BadRequestException(BAD_ME_CURSOR);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 2 ||
    typeof (value as MeCursor).at !== 'string' ||
    typeof (value as MeCursor).id !== 'string' ||
    !ISO_PATTERN.test((value as MeCursor).at) ||
    !ID_PATTERN.test((value as MeCursor).id)
  ) {
    throw new BadRequestException(BAD_ME_CURSOR);
  }
  const at = new Date((value as MeCursor).at);
  // Postgres holds years 1 to 9999 only; a time it cannot hold is not ours.
  if (
    Number.isNaN(at.getTime()) ||
    at.getUTCFullYear() < 1970 ||
    at.getUTCFullYear() > 9999
  ) {
    throw new BadRequestException(BAD_ME_CURSOR);
  }
  return { at, id: (value as MeCursor).id };
}

/**
 * Splits a fetched `limit + 1` rows into the page and its next cursor:
 * `nextCursor` is set only when a row follows, so a last page that is exactly
 * full carries none.
 */
export function pageOf<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => { at: Date; id: string },
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = keyOf(page[page.length - 1]);
  return { rows: page, nextCursor: encodeMeCursor(last.at, last.id) };
}
