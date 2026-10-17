import { BadRequestException } from '@nestjs/common';
import { PAYMENT_KINDS, type PaymentKind } from '../dto/money-enums';

/**
 * The cursor of the per-content earnings (task WALLET-16, CONVENTIONS.md
 * section 26): opaque to the app, `e1.` plus base64url of the month it was
 * given for and the last row's earned kobo, kind and target. The list is
 * ordered by earned kobo (largest first), then kind, then target, so the next
 * page is everything after that triple.
 */
const PREFIX = 'e1.';
export const BAD_EARNING_CURSOR_MESSAGE = 'cursor is not one this list gave.';

export interface EarningContentCursor {
  /** YYYY-MM: the month the scroll is about. */
  month: string;
  /** What the last row earned. */
  earnedKobo: bigint;
  kind: PaymentKind;
  targetId: string;
}

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const KOBO = /^[0-9]{1,18}$/;
const TARGET = /^[A-Za-z0-9_-]{1,200}$/;

export function encodeEarningCursor(c: EarningContentCursor): string {
  return (
    PREFIX +
    Buffer.from(
      JSON.stringify([c.month, c.earnedKobo.toString(), c.kind, c.targetId]),
      'utf8',
    ).toString('base64url')
  );
}

export function decodeEarningCursor(raw: string): EarningContentCursor {
  const bad = () => new BadRequestException(BAD_EARNING_CURSOR_MESSAGE);
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
    parsed.length !== 4 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    typeof parsed[3] !== 'string' ||
    !MONTH.test(parsed[0]) ||
    parsed[0].startsWith('0000') ||
    !KOBO.test(parsed[1]) ||
    !(PAYMENT_KINDS as readonly string[]).includes(parsed[2]) ||
    !TARGET.test(parsed[3])
  ) {
    throw bad();
  }
  return {
    month: parsed[0],
    earnedKobo: BigInt(parsed[1]),
    kind: parsed[2] as PaymentKind,
    targetId: parsed[3],
  };
}
