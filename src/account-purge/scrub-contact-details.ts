/**
 * SETTINGS-06 rounds 8 and 9 (lead rulings, 17 Oct 2026). A piece a buyer paid
 * for keeps its title and description as bought, but a creator who deleted
 * their account must not leave an email address or a phone number behind in
 * them. Each one is replaced with this word; nothing else in the text changes.
 */
export const SCRUBBED_WORD = '[removed]';

/*
 * Round 9: no regular expression decides where a number starts or ends. The
 * round 8 pattern took a whole run of digits and separators and judged its
 * total, so two numbers side by side were judged as one (the second leaked), a
 * year or a price list was swallowed with its neighbours, and it was
 * quadratic on long text. This scanner reads ONE number at a time by its own
 * shape, and goes over the text once.
 *
 * A phone number is, in this order of preference:
 *   - Nigerian local: `0` and ten more digits (11 in all), 0801 234 5678;
 *   - Nigerian international: `234` and ten digits, with or without a leading
 *     `+`, and with an optional `(0)` after the code, +234 (0) 801 234 5678;
 *   - any other international number: `+` and 10 to 15 digits.
 * The digits may be split into groups of two or more by one separator: a
 * space, dash, dot, comma or slash, with brackets round a group, (0801) 234
 * 5678. A number ends at its last digit, so `0801 234 5678 2026` is a phone
 * number and a year, and `08012345678 08098765432` is two phone numbers. It
 * may not start inside a run of digits or end in one. Letters on either side
 * do not matter ("WhatsApp08012345678"). Prices, years, dates, counts and
 * references are not shaped like this and stay.
 *
 * An email address is a local part, an `@` and a dotted domain.
 */

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isAlnum = (c: string): boolean =>
  isDigit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const SEPARATORS = ' -./,';

const LOCAL_PART = (c: string): boolean => isAlnum(c) || '._%+-'.includes(c);
const DOMAIN_PART = (c: string): boolean =>
  isAlnum(c) || c === '.' || c === '-';

/** Replaces every email address, in one pass: it walks out from each `@`. */
function scrubEmails(text: string): string {
  let at = text.indexOf('@');
  if (at === -1) return text;
  const out: string[] = [];
  let copied = 0;
  while (at !== -1) {
    let start = at;
    while (start > copied && LOCAL_PART(text[start - 1])) start -= 1;
    let end = at + 1;
    while (end < text.length && DOMAIN_PART(text[end])) end += 1;
    // A sentence's full stop or a dash after the address is not part of it.
    while (end > at + 1 && !isAlnum(text[end - 1])) end -= 1;
    if (start < at && end > at + 1) {
      out.push(text.slice(copied, start), SCRUBBED_WORD);
      copied = end;
    }
    at = text.indexOf('@', Math.max(end, at + 1));
  }
  out.push(text.slice(copied));
  return out.join('');
}

/**
 * Reads the digit groups of ONE number from `from` and returns the index just
 * after its last digit, or -1 when what is there is not a number of this
 * shape. It needs exactly `want` digits, or between 10 and `want` when
 * `atMost`. Groups are whole runs of digits (a run that would pass the count
 * is not cut: the shape is wrong), at least `minGroup` long, and are told
 * apart by a gap of one separator and the brackets round a group. It reads at
 * most `want` + 1 digits of any run, so its work does not depend on how long
 * the text is.
 */
function readDigits(
  text: string,
  from: number,
  want: number,
  atMost: boolean,
  minGroup: number,
): number {
  let i = from;
  let count = 0;
  let end = -1;
  let endCount = 0;
  for (;;) {
    let len = 0;
    while (
      len <= want - count &&
      i + len < text.length &&
      isDigit(text[i + len])
    ) {
      len += 1;
    }
    if (len === 0) break;
    if (len > want - count) {
      if (atMost) break;
      return -1;
    }
    if (len < minGroup) return -1;
    i += len;
    count += len;
    end = i;
    endCount = count;
    if (count === want) break;
    // the gap to the next group
    let j = i;
    if (text[j] === ')') j += 1;
    if (j < text.length && SEPARATORS.includes(text[j])) j += 1;
    if (text[j] === '(') j += 1;
    if (j === i || j - i > 3 || !isDigit(text[j] ?? '')) break;
    i = j;
  }
  if (end === -1) return -1;
  return (atMost ? endCount >= 10 : endCount === want) ? end : -1;
}

const TRUNK_BRACKET = /^\s?\(0\)\s?/;

/** `234` and ten digits, the code first, with or without a bracketed `(0)`. */
function nigerianInternational(text: string, from: number): number {
  const exact = readDigits(text, from, 13, false, 2);
  if (exact !== -1) return exact;
  const bracket = TRUNK_BRACKET.exec(text.slice(from + 3, from + 9));
  return bracket
    ? readDigits(text, from + 3 + bracket[0].length, 10, false, 2)
    : -1;
}

/** If a phone number starts at `i`, the index after it; otherwise -1. */
function phoneEnd(text: string, i: number): number {
  const c = text[i];
  if (c === '+') {
    if (text.startsWith('234', i + 1)) {
      const nigerian = nigerianInternational(text, i + 1);
      if (nigerian !== -1) return nigerian;
    }
    return readDigits(text, i + 1, 15, true, 1);
  }
  if (c === '(') {
    return text[i + 1] === '0' ? readDigits(text, i + 1, 11, false, 2) : -1;
  }
  if (c === '0') return readDigits(text, i, 11, false, 2);
  if (c === '2' && text.startsWith('234', i)) {
    return nigerianInternational(text, i);
  }
  return -1;
}

/** Replaces every phone number, one at a time, in one pass. */
function scrubPhones(text: string): string {
  const out: string[] = [];
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // a number does not start in the middle of a run of digits
    const starts =
      (isDigit(c) && !(i > 0 && isDigit(text[i - 1]))) ||
      c === '+' ||
      c === '(';
    const end = starts ? phoneEnd(text, i) : -1;
    if (end === -1) {
      i += 1;
      continue;
    }
    out.push(text.slice(copied, i), SCRUBBED_WORD);
    copied = end;
    i = end;
  }
  if (copied === 0) return text;
  out.push(text.slice(copied));
  return out.join('');
}

export function scrubContactDetails(text: string): string {
  if (!text) return text;
  return scrubPhones(scrubEmails(text));
}
