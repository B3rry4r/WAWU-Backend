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
  const at = new Date(raw.slice(0, bar));
  const key = raw.slice(bar + 1);
  if (bar < 1 || Number.isNaN(at.getTime()) || !KEY.test(key)) {
    throw new BadRequestException('cursor is not one this server gave out');
  }
  return { at, key };
}
