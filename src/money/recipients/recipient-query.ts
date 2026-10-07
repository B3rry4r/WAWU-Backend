import { BadRequestException } from '@nestjs/common';
import { toLocalNigerianPhone } from '../../wallet-provider/nigerian-phone';
import {
  RECIPIENT_SEARCH_MAX_CHARS,
  RECIPIENT_SEARCH_MIN_CHARS,
} from './recipient-config';

/** What a search asked for, once its text is read (WALLET-08). */
export type RecipientQuery =
  /** A Nigerian mobile written any common way, as E.164. Matched in full. */
  | { kind: 'phone'; e164: string }
  /** `@text`: a handle, by its beginning. */
  | { kind: 'handle'; prefix: string }
  /** Plain text: a name (any word of it) or a handle, by its beginning. */
  | { kind: 'name'; prefix: string };

/** A NUL byte cannot be in a text column; it is dropped, not searched for. */
const NUL = String.fromCharCode(0);

export const SEARCH_TOO_SHORT_MESSAGE = `Type at least ${RECIPIENT_SEARCH_MIN_CHARS} letters of a name or @handle.`;
export const SEARCH_TOO_LONG_MESSAGE = `Search for ${RECIPIENT_SEARCH_MAX_CHARS} characters or fewer.`;

/**
 * Reads the search text of `GET /money/recipients`.
 *
 * - A phone is a phone only when it is a whole Nigerian mobile after
 *   normalising (`toLocalNigerianPhone`: 080..., 80..., 234..., +234..., with
 *   spaces, dashes and brackets). It is then searched as a phone and as
 *   nothing else, so a handle written like a number can never stand in for
 *   someone's phone. Digits that are not a whole mobile are text: they match
 *   a name or handle only by its beginning, never a phone.
 * - Text is trimmed, its runs of spaces made one, and must be at least
 *   RECIPIENT_SEARCH_MIN_CHARS long (counted in characters, after a leading
 *   "@"); otherwise a plain 400, the same refusal the ValidationPipe gives a
 *   malformed field, so the app has one 400 to read.
 */
export function readRecipientQuery(raw: string): RecipientQuery {
  const text = raw.split(NUL).join('').trim().replace(/\s+/g, ' ');
  if ([...text].length > RECIPIENT_SEARCH_MAX_CHARS) {
    throw new BadRequestException(SEARCH_TOO_LONG_MESSAGE);
  }
  const local = toLocalNigerianPhone(text);
  if (local !== null) return { kind: 'phone', e164: `+234${local.slice(1)}` };
  if (text.startsWith('@')) {
    const prefix = text.slice(1).trim();
    if ([...prefix].length < RECIPIENT_SEARCH_MIN_CHARS) {
      throw new BadRequestException(SEARCH_TOO_SHORT_MESSAGE);
    }
    return { kind: 'handle', prefix };
  }
  if ([...text].length < RECIPIENT_SEARCH_MIN_CHARS) {
    throw new BadRequestException(SEARCH_TOO_SHORT_MESSAGE);
  }
  return { kind: 'name', prefix: text };
}

/** `text` as a LIKE pattern body: the characters LIKE treats as wildcards are plain. */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
