import { BadRequestException } from '@nestjs/common';

/**
 * A cursor is a point in time and nothing else. `exact` is set on the cursor
 * that continues a page (read from it as it is); an ordinary cursor is read
 * from a little earlier (see LIVE_LIMITS.catchUpOverlapMs).
 */
export interface LiveCursor {
  at: Date;
  exact: boolean;
}

export function encodeLiveCursor(at: Date, exact = false): string {
  return Buffer.from(`${at.toISOString()}|${exact ? 1 : 0}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeLiveCursor(cursor: string): LiveCursor {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, flag, ...rest] = raw.split('|');
  const at = new Date(iso ?? '');
  if (
    rest.length > 0 ||
    (flag !== '0' && flag !== '1') ||
    Number.isNaN(at.getTime()) ||
    at.toISOString() !== iso
  ) {
    throw new BadRequestException('cursor is not one this server gave out');
  }
  return { at, exact: flag === '1' };
}
