import { BadRequestException } from '@nestjs/common';

/**
 * Which list a row came from, in the order a page lists them when rows share
 * a time: chat messages, read marks, then community messages.
 */
export type LiveKind = 'm' | 'r' | 'p';
export const LIVE_KIND_RANK: Record<LiveKind, number> = { m: 0, r: 1, p: 2 };

/** The last row a page ended on. */
export interface LivePosition {
  kind: LiveKind;
  id: string;
}

/**
 * A cursor is a time, plus, when it continues a page, the last row that page
 * ended on. With a position it is read exactly (everything after that row in
 * the page order, which is time, then list, then id); without one it is read
 * from a little earlier (see LIVE_LIMITS.catchUpOverlapMs).
 */
export interface LiveCursor {
  at: Date;
  position: LivePosition | null;
}

export function encodeLiveCursor(at: Date, position?: LivePosition): string {
  const text = position
    ? `${at.toISOString()}|1|${position.kind}|${position.id}`
    : `${at.toISOString()}|0`;
  return Buffer.from(text, 'utf8').toString('base64url');
}

const UUID = /^[0-9a-f-]{36}$/i;

export function decodeLiveCursor(cursor: string): LiveCursor {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(parts[0] ?? '');
  const validTime =
    !Number.isNaN(at.getTime()) && at.toISOString() === parts[0];
  if (validTime && parts.length === 2 && parts[1] === '0') {
    return { at, position: null };
  }
  const kind = parts[2];
  if (
    validTime &&
    parts.length === 4 &&
    parts[1] === '1' &&
    (kind === 'm' || kind === 'r' || kind === 'p') &&
    UUID.test(parts[3])
  ) {
    return { at, position: { kind, id: parts[3] } };
  }
  throw new BadRequestException('cursor is not one this server gave out');
}
