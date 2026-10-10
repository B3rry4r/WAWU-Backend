import { BadRequestException } from '@nestjs/common';

/**
 * The cursor of the holds list (task MONEY-18, CONVENTIONS.md section 6):
 * opaque to the app, `h1.` plus base64url of the last row's `heldAt` (ms) and
 * id. A hold's `heldAt` never changes, so a hold settling mid-scroll does not
 * move it across a cursor already handed out.
 */
const PREFIX = 'h1.';
export const BAD_HOLD_CURSOR_MESSAGE = 'cursor is not one this list gave.';

export interface HoldCursor {
  at: Date;
  id: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeHoldCursor(c: HoldCursor): string {
  return (
    PREFIX +
    Buffer.from(JSON.stringify([c.at.getTime(), c.id]), 'utf8').toString(
      'base64url',
    )
  );
}

export function decodeHoldCursor(raw: string): HoldCursor {
  const bad = () => new BadRequestException(BAD_HOLD_CURSOR_MESSAGE);
  if (!raw.startsWith(PREFIX)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'number' ||
    typeof parsed[1] !== 'string' ||
    !Number.isSafeInteger(parsed[0]) ||
    !UUID.test(parsed[1])
  ) {
    throw bad();
  }
  const at = new Date(parsed[0]);
  // Postgres holds nothing before year 1; a cursor must be a time it can compare.
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1) throw bad();
  return { at, id: parsed[1] };
}
