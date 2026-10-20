import { Prisma } from '../../generated/prisma/client';

/**
 * EXPLORE-05 round 3. What may be offered to everybody as "People are
 * searching": the NAME of a public thing, and nothing a searcher typed.
 *
 * Round 2 tried to spot phone numbers, emails and links in what people typed,
 * form by form, and the verifier found a new form each time. This is the other
 * way round (lead ruling, 16 Oct 2026). A popular entry is shown only when the
 * text people searched EQUALS the name of something a signed-out visitor can
 * find today (a content title, a creator's handle with a creator state, a
 * community name, a category name), and the text shown is that thing's own
 * name. On top of that sits one strict character rule on the shown name.
 *
 * Equality is read after both sides are brought to one plain form
 * (`foldSearchText`): NFKC, lower case, lookalike letters and digits written
 * as the plain ones, white space made single spaces. The same steps run in the
 * database (`foldSql`); a spec feeds both the same texts and compares.
 *
 * The character rule (`isShowableName`, `showableNameSql`): letters, spaces
 * and `' & -`, with at most four digits in the whole name. "Letters" are Latin
 * script letters with their accents and the combining marks that follow them
 * (Yoruba, Igbo, Hausa and Akan names need those); a letter of another script
 * is refused, because a name in another script is how a lookalike of a Latin
 * word, or a number written in Chinese numerals, would get on the list. No dot,
 * slash, colon, at sign, underscore or bracket can be in a shown name, and
 * four digits are too few for any phone number.
 *
 * The cost, accepted (lead ruling): a true name with a dot or a long number is
 * never shown ("node.js course", "next.js tutorial", "mr.beast", a handle with
 * an underscore, a name with five digits). A list of eight loses nothing that
 * matters; a phone number on every visitor's Search costs a lot.
 */

/** At most this many digits in a shown name; four are too few for a number. */
export const MAX_DIGITS_IN_NAME = 4;

// ---------------------------------------------------------------- the fold

/**
 * Letters of other scripts that look like a Latin letter, as [code point of
 * the lower-case letter, the Latin letter]. The upper-case form of each is
 * added below, so the fold does not depend on the database's lower().
 */
const LOOKALIKE_LETTERS: readonly [number, string][] = [
  // Cyrillic
  [0x0430, 'a'],
  [0x0432, 'b'],
  [0x0435, 'e'],
  [0x043a, 'k'],
  [0x043c, 'm'],
  [0x043d, 'h'],
  [0x043e, 'o'],
  [0x0440, 'p'],
  [0x0441, 'c'],
  [0x0442, 't'],
  [0x0443, 'y'],
  [0x0445, 'x'],
  [0x0455, 's'],
  [0x0456, 'i'],
  [0x0458, 'j'],
  [0x0475, 'v'],
  [0x04af, 'y'],
  [0x04bb, 'h'],
  [0x04cf, 'l'],
  [0x0501, 'd'],
  [0x051b, 'q'],
  [0x051d, 'w'],
  // Greek
  [0x03b1, 'a'],
  [0x03b2, 'b'],
  [0x03b3, 'y'],
  [0x03b5, 'e'],
  [0x03b7, 'n'],
  [0x03b9, 'i'],
  [0x03ba, 'k'],
  [0x03bc, 'u'],
  [0x03bd, 'v'],
  [0x03bf, 'o'],
  [0x03c1, 'p'],
  [0x03c4, 't'],
  [0x03c5, 'u'],
  [0x03c7, 'x'],
  [0x03c9, 'w'],
  [0x03f2, 'c'],
  [0x03f3, 'j'],
];

/** Latin-script lookalikes that NFKC leaves alone (no upper-case twin added). Folded in the search, never allowed in a shown name (`LATIN_LETTERS`). */
const LOOKALIKE_LATIN: readonly [number, string][] = [
  [0x0131, 'i'], // dotless i
  [0x0251, 'a'],
  [0x0261, 'g'],
];

/**
 * Circled, double-circled and dingbat digits that NFKC leaves alone (it reads
 * the circled numbers 1 to 20 itself). Ten is two characters, so it is left
 * out: translate() is one character for one character.
 */
function digitSymbols(): [number, string][] {
  const out: [number, string][] = [[0x24ff, '0']];
  for (let k = 0; k < 9; k++) {
    for (const first of [0x24f5, 0x2776, 0x2780, 0x278a])
      out.push([first + k, String(k + 1)]);
  }
  return out;
}

const FOLD_PAIRS: ReadonlyMap<string, string> = (() => {
  const pairs = new Map<string, string>();
  for (const [cp, latin] of LOOKALIKE_LETTERS) {
    const lower = String.fromCodePoint(cp);
    pairs.set(lower, latin);
    const upper = lower.toUpperCase();
    if ([...upper].length === 1 && upper !== lower) pairs.set(upper, latin);
  }
  for (const [cp, latin] of [...LOOKALIKE_LATIN, ...digitSymbols()])
    pairs.set(String.fromCodePoint(cp), latin);
  return pairs;
})();

/** The two strings the database's translate() takes: from, and to. */
export const FOLD_FROM = [...FOLD_PAIRS.keys()].join('');
export const FOLD_TO = [...FOLD_PAIRS.values()].join('');

/** A digit written as a keycap: the digit, an optional variation selector, U+20E3. */
const KEYCAP = '([0-9])️?⃣';

/**
 * A search text, or a name, in the one plain form that two of them are
 * compared in: NFKC (full-width and circled forms become plain), lower case,
 * keycap digits and circled/dingbat digits as digits, Cyrillic and Greek
 * lookalikes as Latin letters, every run of white space one space, trimmed.
 */
export function foldSearchText(text: string): string {
  let t = text.normalize('NFKC').toLowerCase();
  t = t.replace(new RegExp(KEYCAP, 'g'), '$1');
  t = [...t].map((c) => FOLD_PAIRS.get(c) ?? c).join('');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * The same fold as SQL, for a text expression. The steps and their order are
 * foldSearchText's; popular-name.contract.spec.ts feeds both the same texts.
 */
export function foldSql(text: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`btrim(regexp_replace(translate(regexp_replace(lower(normalize(${text}, NFKC)), ${KEYCAP}::text, '\\1', 'g'), ${FOLD_FROM}::text, ${FOLD_TO}::text), '\\s+', ' ', 'g'), ' ')`;
}

// ------------------------------------------------------- the character rule

/**
 * Latin letters: ASCII, Latin-1 and Latin Extended (A, B, IPA), Extended Additional, except the three lookalikes the fold
 * reads as plain letters (U+0131 dotless i, U+0251 latin alpha, U+0261 script g, `LOOKALIKE_LATIN`). A shown name that
 * held one would be found by neither its own spelling nor the plain one, and a lookalike-spelled public thing could take
 * over the shown spelling of an organic entry, so such a name is not shown (SWEEP-APP-4, EXPLORE-05 R3-2). Written with
 * escapes so the ranges read: C0-D6, D8-F6, F8-130, 132-250, 252-260, 262-2AF, 1E00-1EFF.
 */
const LATIN_LETTERS =
  'A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u0130\u0132-\u0250\u0252-\u0260\u0262-\u02af\u1e00-\u1eff';
/** Combining accents, allowed only straight after a letter. */
const ACCENTS = '̀-ͯ';

/** The whole name: letters (with accents), digits, space, apostrophe, ampersand, hyphen. */
export const NAME_PATTERN = `^(?:[${LATIN_LETTERS}][${ACCENTS}]*|[0-9]|[ '&-])+$`;
/** At least one letter, so a name of only `& -` is not a name. */
export const LETTER_PATTERN = `[${LATIN_LETTERS}]`;

/** Whether this name may be shown on the public list. */
export function isShowableName(name: string): boolean {
  if (!new RegExp(NAME_PATTERN).test(name)) return false;
  if (!new RegExp(LETTER_PATTERN).test(name)) return false;
  return (name.match(/[0-9]/g) ?? []).length <= MAX_DIGITS_IN_NAME;
}

/** The same rule as a SQL condition on a text expression. */
export function showableNameSql(name: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${name} ~ ${NAME_PATTERN}::text AND ${name} ~ ${LETTER_PATTERN}::text AND char_length(regexp_replace(${name}, '[^0-9]', '', 'g')) <= ${MAX_DIGITS_IN_NAME}::int)`;
}
