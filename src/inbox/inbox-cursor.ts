import { BadRequestException } from '@nestjs/common';

/**
 * A cursor is the last row's activity time and its row key, base64url so the
 * app treats it as opaque. The pair is the whole sort key, and the key is
 * unique, so a page boundary falls between two rows exactly: rows that share
 * a time are told apart by key, never skipped or repeated.
 */
export interface InboxCursor {
  at: Date;
  key: string;
}

/** `chat:<uuid>`, `community:<uuid>` or `paid_dm:<side>:<uuid>`. */
const KEY = /^(chat|community|paid_dm:(fan|creator)):[0-9a-f-]{36}$/i;

/**
 * The only time form this server writes: four-digit year, milliseconds, Z.
 * Anything else (extended years, a missing zone, a date that JavaScript
 * rolls over) is not a cursor it gave out.
 */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Rows are never older than the epoch, and Postgres stops at year 9999 here. */
const EARLIEST = Date.UTC(1970, 0, 1);
const LATEST = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export function encodeInboxCursor(at: Date, key: string): string {
  return Buffer.from(`${at.toISOString()}|${key}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeInboxCursor(
  cursor: string | undefined,
): InboxCursor | null {
  if (cursor === undefined) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = raw.indexOf('|');
  const time = raw.slice(0, bar);
  const at = new Date(time);
  const key = raw.slice(bar + 1);
  if (
    bar < 1 ||
    !TIME.test(time) ||
    Number.isNaN(at.getTime()) ||
    at.getTime() < EARLIEST ||
    at.getTime() > LATEST ||
    at.toISOString() !== time ||
    !KEY.test(key)
  ) {
    throw new BadRequestException('cursor is not one this server gave out');
  }
  return { at, key };
}
