import { randomBytes } from 'node:crypto';

/**
 * A receipt's public code (task WALLET-18): 12 characters of Crockford's
 * base 32, drawn from the operating system's random source. 32 to the 12th
 * is 2 to the 60th codes, so with the public lookup's throttle
 * (RECEIPT_LOOKUP_THROTTLE) nobody finds a receipt by guessing. A code is
 * never a count, a time or anything taken from an id.
 *
 * Crockford's alphabet has no I, L, O or U, so a code read aloud or typed
 * from a picture is hard to get wrong; when it is typed, `normalReceiptCode`
 * reads O as 0 and I or L as 1, ignores case, and drops the spaces and
 * hyphens a person may add.
 */
export const RECEIPT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECEIPT_CODE_LENGTH = 12;

/** A new code. Each byte keeps 5 random bits; 256 is a multiple of 32, so none is likelier than another. */
export function newReceiptCode(): string {
  const bytes = randomBytes(RECEIPT_CODE_LENGTH);
  let code = '';
  for (const b of bytes) code += RECEIPT_CODE_ALPHABET[b & 31];
  return code;
}

const SHAPE = new RegExp(
  `^[${RECEIPT_CODE_ALPHABET}]{${RECEIPT_CODE_LENGTH}}$`,
);

/**
 * The code as it is stored, from what someone typed or followed; null when
 * it cannot be a code at all. The caller still looks a null up (as a value
 * no code has), so a malformed code costs the same as any other miss.
 */
export function normalReceiptCode(raw: string): string | null {
  if (raw.length > 64) return null;
  const code = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return SHAPE.test(code) ? code : null;
}

/** What a receipt prints and the app shows: `wawu/r/<code>` (links are written `wawu/...`). */
export function receiptLink(code: string): string {
  return `wawu/r/${code}`;
}
