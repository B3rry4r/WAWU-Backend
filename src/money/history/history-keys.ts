import { BadRequestException } from '@nestjs/common';

/**
 * The two opaque values the history hands the app and takes back as given
 * (task MONEY-15, docs/contract/CONVENTIONS.md section 6): a page cursor
 * and a grouped row's key. Both are base64url JSON, so they carry no
 * meaning the app could depend on, and both are checked strictly on the way
 * back in: anything this history did not write is a 400, never a query.
 */

/** Where a page stopped: the last row's time and id (newest first). */
export interface HistoryCursor {
  /** The row's `occurredAt`, ISO 8601 UTC with milliseconds. */
  at: string;
  id: string;
}

/** A grouped row: unlock earnings of one piece on one Africa/Lagos day. */
export interface HistoryGroupKey {
  targetId: string;
  /** YYYY-MM-DD in Africa/Lagos time. */
  day: string;
}

const CURSOR_PREFIX = 'c1.';
const GROUP_PREFIX = 'g1.';

/** Ledger ids are Postgres/Prisma uuids. */
const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The longest target id a group key carries (the ledger keeps link ids as sent). */
const MAX_TARGET_ID = 200;

export const BAD_CURSOR_MESSAGE = 'cursor is not one this history gave.';
export const BAD_GROUP_MESSAGE = 'group is not a key this history gave.';

function encode(prefix: string, value: unknown): string {
  return (
    prefix + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  );
}

function decode(prefix: string, raw: string): unknown {
  if (!raw.startsWith(prefix)) return undefined;
  const body = raw.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** A string that Postgres can take as a parameter and the app can read back. */
function plainText(v: unknown, max: number): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(v)
  );
}

export function encodeCursor(c: HistoryCursor): string {
  return encode(CURSOR_PREFIX, [c.at, c.id]);
}

export function decodeCursor(raw: string): HistoryCursor {
  const v = decode(CURSOR_PREFIX, raw);
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'string' &&
    ISO_PATTERN.test(v[0]) &&
    !Number.isNaN(Date.parse(v[0])) &&
    new Date(v[0]).toISOString() === v[0] &&
    typeof v[1] === 'string' &&
    ID_PATTERN.test(v[1])
  ) {
    return { at: v[0], id: v[1].toLowerCase() };
  }
  throw new BadRequestException(BAD_CURSOR_MESSAGE);
}

export function encodeGroupKey(g: HistoryGroupKey): string {
  return encode(GROUP_PREFIX, [g.targetId, g.day]);
}

export function decodeGroupKey(raw: string): HistoryGroupKey {
  const v = decode(GROUP_PREFIX, raw);
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    plainText(v[0], MAX_TARGET_ID) &&
    typeof v[1] === 'string' &&
    DAY_PATTERN.test(v[1])
  ) {
    return { targetId: v[0], day: v[1] };
  }
  throw new BadRequestException(BAD_GROUP_MESSAGE);
}
