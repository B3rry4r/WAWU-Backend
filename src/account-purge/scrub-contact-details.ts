/**
 * SETTINGS-06 round 8 (lead ruling, 17 Oct 2026). A piece a buyer paid for
 * keeps its title and description as bought, but a creator who deleted their
 * account must not leave an email address or a phone number behind in them.
 * Each one is replaced with this word; nothing else in the text changes.
 */
export const SCRUBBED_WORD = '[removed]';

/** An email address: local part, `@`, a dotted domain. */
const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Something shaped like a phone number: digits with spaces, dots, dashes or
 * brackets between them, at least 9 characters long, not glued to a letter or
 * a digit on either side. Only a run of 10 to 15 digits counts as a phone
 * number (the range of an international number); a price, a year, a date or a
 * count of lessons has fewer digits and is left as written.
 */
const PHONE = /(?<![A-Za-z0-9])\+?\(?\d[\d\s().-]{7,}\d(?![A-Za-z0-9])/g;

export function scrubContactDetails(text: string): string {
  if (!text) return text;
  return text.replace(EMAIL, SCRUBBED_WORD).replace(PHONE, (found) => {
    const digits = found.replace(/\D/g, '').length;
    return digits >= 10 && digits <= 15 ? SCRUBBED_WORD : found;
  });
}
