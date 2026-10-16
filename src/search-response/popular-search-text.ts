/**
 * EXPLORE-05 round 2. Which search texts may never be offered to everybody as
 * "People are searching", however many accounts typed them.
 *
 * A person's own Recent keeps whatever they searched. The public list is
 * different: three accounts (one person can open three) typing the same text
 * put it on every visitor's Search landing, so a phone number, an email
 * address, a link or a sentence of spam must never get there. The text is
 * first brought to one plain form, so the same details written another way
 * (Arabic digits, dots, brackets, "(at)") are caught the same:
 *
 *  1. NFKC, so full-width letters, digits and "@" become ordinary ones;
 *  2. every other Unicode digit (Arabic-Indic, Devanagari, ...) becomes 0 to 9;
 *  3. lower case.
 *
 * Then a text is refused when it:
 *  - holds a zero-width, control or other invisible character (checked first,
 *    on the text as typed: such a character is how digits get split);
 *  - reads as an email address: an "@", "(at)", "[at]", "(dot)" and the like,
 *    or the word "at" or "dot" with a word before and after it;
 *  - reads as a link or a domain: http, https, ftp, www, "://", or a name, a
 *    dot and a top-level domain ("evil.example");
 *  - has a run of 7 or more digits once the separators . / _ ( ) - and spaces
 *    are taken out ("0801.234.5678", "(0801) 234 5678", "234 801 234 5678").
 *
 * Whether the text finds anything a visitor can see is a separate test, made
 * against the database (SearchHistoryService.hasPublicResult).
 */

/** Why a text is not offered; null when it may be. */
export type PopularRefusal = 'invisible' | 'email' | 'link' | 'number';

/**
 * Control characters, every "format" character (zero-width space, joiners,
 * direction marks, word joiner, BOM, soft hyphen) and the letters that draw
 * nothing (combining grapheme joiner, Hangul fillers).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}͏ᅟᅠㅤﾠ]/u;

/** "(at)", "[at]", "{dot}", "<at>" with or without spaces inside. */
const BRACKETED_WORD = /[([{<]\s*(?:at|dot)\s*[)\]}>]/u;

const SCHEME_OR_WWW = /\b(?:https?|ftp|www)\b|:\/\//u;

/** name, a dot, a top-level domain of two letters or more. */
const DOMAIN = /[\p{L}\p{N}][\p{L}\p{N}-]*\.\p{L}{2,}/u;

const SEPARATORS = /[\s./_()-]/gu;

/** A phone number has seven digits or more; 7 is the shortest local number. */
const PHONE_DIGITS = 7;
const PHONE_RUN = new RegExp(`\\d{${PHONE_DIGITS},}`);

/**
 * The value (0 to 9) of every Unicode decimal digit. The digits of one script
 * are ten code points in a row and every run is a whole number of tens, so the
 * place in the run is the value. Built once, when the module loads.
 */
const DIGIT_VALUE: ReadonlyMap<number, number> = (() => {
  const values = new Map<number, number>();
  const decimal = /^\p{Nd}$/u;
  let place = 0;
  for (let cp = 0x30; cp <= 0x1ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) {
      place = 0;
      continue;
    }
    if (decimal.test(String.fromCodePoint(cp))) {
      values.set(cp, place % 10);
      place += 1;
    } else {
      place = 0;
    }
  }
  return values;
})();

/** Every Unicode decimal digit written as 0 to 9. */
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (c) =>
    String(DIGIT_VALUE.get(c.codePointAt(0) as number) ?? c),
  );
}

/** "chidinma at gmail dot com": the word at or dot with a word on each side. */
function spelledOutEmail(text: string): boolean {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  for (let i = 1; i < words.length - 1; i++) {
    if (words[i] === 'at' || words[i] === 'dot') return true;
  }
  return false;
}

/** Why this search text may not be a popular search; null when it may. */
export function whyNotPopular(queryKey: string): PopularRefusal | null {
  if (INVISIBLE.test(queryKey)) return 'invisible';
  const text = asciiDigits(queryKey.normalize('NFKC').toLowerCase());
  if (text.includes('@') || BRACKETED_WORD.test(text) || spelledOutEmail(text))
    return 'email';
  if (SCHEME_OR_WWW.test(text) || DOMAIN.test(text)) return 'link';
  const digitsOnly = text.replace(SEPARATORS, '');
  if (PHONE_RUN.test(digitsOnly)) return 'number';
  return null;
}
