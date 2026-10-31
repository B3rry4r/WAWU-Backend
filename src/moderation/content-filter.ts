import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_PHRASES,
  ALLOWED_WORDS,
  BLOCKED_WORD_GROUPS,
  SPLIT_WORDS,
  STRONG_WORDS,
  builtInWords,
} from './blocked-words';

/**
 * MOD-ROOMS (R-122). The one filter for objectionable words. Pure functions, no database and nothing to inject, so a
 * service that saves text calls `assertContentAllowed(...)` and nothing else changes in how it is built or tested.
 *
 * Apple App Review guideline 1.2 asks for "a method for filtering objectionable material from being posted". A text
 * with a listed word is REFUSED (400, `reason.code` `content_blocked`) and nothing is saved; the answer never says which
 * word, so the list is not a guessing game.
 *
 * WHAT IS MATCHED (the list is in blocked-words.ts):
 *  - whole words only: "Scunthorpe", "class" and "assess" are never hit;
 *  - case, accents (`ọ` is `o`), the zero-width and other invisible characters people hide in a word, and emoji put
 *    between its letters ("f😀uck") are ignored;
 *  - look-alike letters from other alphabets are read as the Latin letter they imitate (Cyrillic "с" in "fuсk", "ѕ" in
 *    "ѕhit", Greek "ο" and "υ", small capitals, full-width and maths letters);
 *  - a letter written again and again: "fuuuuck";
 *  - simple l33t: `0 1 3 4 5 7 @ $ !` stand for letters ("sh1t", "a$$hole" if listed), `+` for t;
 *  - a masked letter: "f*ck" (at least two real letters must stay, so "**" matches nothing);
 *  - a word spelled out: "f u c k", "f.u.c.k", "f-u-c-k" (four or more single letters in a row), and the spaced phrase
 *    "k y s" (a phrase entry);
 *  - a SHORT set of strong words is caught inside longer words too ("fuckyou", "fuckoff", "bitchass", "muthafucka",
 *    "motherfuckers"; STRONG_WORDS), because people write them run together;
 *  - the fuck family split into pieces of four letters or fewer ("fu ck", "fuc k", "f uck", "fu.ck", "f u ck"; SPLIT_WORDS).
 * What is NOT caught, on purpose, and left to Report (the moderators' backstop): any other word split with a space
 * ("sh it", "bi tch", "nig ger"), because two short real words joined make a listed word often enough to refuse a clean
 * message ("NIG GER" in a score line, "Fu K" as a name and an initial); a word with a letter swapped for one that is not
 * on the look-alike list; and words in a language the list does not hold.
 * A few innocent phrases and words that hold a listed word are taken out first (blocked-words.ts, ALLOWED_PHRASES and
 * ALLOWED_WORDS): "spicy jollof", "Spicer", "Kike Adeyemi", "kaffir lime", "Maine Coon" and "Twatt" all pass.
 *
 * The built-in list can be added to without a release: `MODERATION_EXTRA_WORDS`, a comma-separated list, read on each
 * call (so a restart is the only step). It can only add; it cannot take a built-in word out.
 */

/** The `reason.code` of the refusal. The app keys on this, never on the words. */
export const CONTENT_BLOCKED_CODE = 'content_blocked';

/** Two sentences, no em-dash: the app shows them as they are. The app's name is written "Who Made This?" (R-37, R-122). */
export const CONTENT_BLOCKED_MESSAGE =
  'Who Made This? does not allow some of those words. Change them and try again.';

/** Endings a `~` entry takes. */
const ENDINGS = ['s', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y'] as const;

/** What a folded character stands for. */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '+': 't',
};

/** Letters Unicode does not take apart. */
const SPECIAL: Readonly<Record<string, string>> = {
  ɗ: 'd',
  ƙ: 'k',
  ɓ: 'b',
  ƴ: 'y',
  ø: 'o',
  ß: 'ss',
  đ: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  ƒ: 'f',
  ɡ: 'g',
};

/**
 * Letters from other alphabets that look like a Latin letter (M2). Read as that letter, so "fuсk" (Cyrillic с) and "ѕhit"
 * (Cyrillic ѕ) meet "fuck" and "shit". Written as `lookalike` followed by the letters it stands for, in one string per
 * Latin letter. Lower case only: the text is lower-cased first.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  a: 'аαᴀ',
  b: 'вβʙ',
  c: 'сϲᴄ',
  d: 'ԁᴅ',
  e: 'еёεᴇ',
  f: 'ꜰ',
  g: 'ɢ',
  h: 'нһʜ',
  i: 'іїιɪ',
  j: 'јᴊ',
  k: 'кκᴋ',
  l: 'ӏʟ',
  m: 'мᴍ',
  n: 'ηɴ',
  o: 'оοօᴏ',
  p: 'рρᴘ',
  q: 'ԛ',
  r: 'ʀ',
  s: 'ѕꜱ',
  t: 'тτᴛ',
  u: 'սυᴜ',
  v: 'νѵᴠ',
  w: 'ѡԝᴡ',
  x: 'хχ',
  y: 'уʏ',
  z: 'ᴢ',
};
const LOOK_ALIKE_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(LOOK_ALIKES).flatMap(([latin, others]) =>
    [...others].map((c): [string, string] => [c, latin]),
  ),
);
const LOOK_ALIKE_PATTERN = new RegExp(
  `[${[...LOOK_ALIKE_OF.keys()].join('')}]`,
  'gu',
);

/** Invisible characters people put inside a word: every format character (zero-width space, joiners, soft hyphen, tags) and the blank fillers. */
const INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0\u180E\u2800]/gu;
/** Emoji and their joiners. Digits and `#` `*` are not matched. */
const EMOJI =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u20E3\uFE0F]/gu;

/** The longest text looked at, so a huge body cannot make a request slow. Longer text is checked in this much from its start and its end. */
const MAX_LOOKED_AT = 20_000;

/**
 * An emoji between letters is read two ways, because both happen: "f😀uck" is `join` (the emoji is nothing, the letters
 * meet) and "fuck😀you" or "kill😀you" is `space` (the emoji is a gap). A text is refused when either reading holds a word.
 */
type EmojiAs = 'join' | 'space';

function lettersOf(text: string, emoji: EmojiAs = 'join'): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ɗƙɓƴøßđłæœıƒɡ]/gu, (c) => SPECIAL[c] ?? c)
    .replace(LOOK_ALIKE_PATTERN, (c) => LOOK_ALIKE_OF.get(c) ?? c)
    .replace(INVISIBLE, '')
    .replace(EMOJI, emoji === 'join' ? '' : ' ')
    .replace(/['’`´]/g, '');
}

/** Escapes nothing: entries are letters and spaces only (checked when compiled). */
function runPattern(word: string): string {
  // Each run of the same letter: one letter in the entry means "one or more", two or more mean "at least that many".
  let out = '';
  for (let i = 0; i < word.length;) {
    let j = i;
    while (j < word.length && word[j] === word[i]) j += 1;
    const n = j - i;
    out += n === 1 ? `${word[i]}+` : `${word[i]}{${n},}`;
    i = j;
  }
  return out;
}

interface Compiled {
  words: RegExp | null;
  phrases: RegExp[];
  /** Single-word entries without `~`, as plain strings, for the masked-letter check. */
  plain: string[];
  /** The same words with their endings written out, for the masked-letter check. */
  withEndings: string[];
}

function clean(entry: string): string {
  return lettersOf(entry)
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compile(entries: readonly string[]): Compiled {
  const singles: string[] = [];
  const phrases: RegExp[] = [];
  const plain: string[] = [];
  const withEndings: string[] = [];
  const endings = ENDINGS.map(runPattern).join('|');
  for (const raw of entries) {
    const takesEndings = raw.trim().endsWith('~');
    const entry = clean(raw.replace(/~$/, ''));
    if (entry.length < 2) continue;
    if (entry.includes(' ')) {
      const body = entry.split(' ').map(runPattern).join(' ');
      phrases.push(new RegExp(`(?:^| )${body}(?: |$)`));
      continue;
    }
    singles.push(
      takesEndings ? `${runPattern(entry)}(?:${endings})?` : runPattern(entry),
    );
    plain.push(entry);
    withEndings.push(entry);
    if (takesEndings) for (const e of ENDINGS) withEndings.push(entry + e);
  }
  return {
    words: singles.length ? new RegExp(`^(?:${singles.join('|')})$`) : null,
    phrases,
    plain,
    withEndings,
  };
}

const BUILT_IN = compile(builtInWords());

/** Innocent phrases, each as a pattern that matches it as whole words with any marks or spaces between them. */
const ALLOWED = ALLOWED_PHRASES.map(clean)
  .filter((phrase) => phrase !== '')
  .map(
    (phrase) =>
      new RegExp(
        `(?<![a-z0-9])${phrase.split(' ').join('[^a-z0-9]+')}(?![a-z0-9])`,
        'g',
      ),
  );
const ALLOWED_TOKENS: ReadonlySet<string> = new Set(ALLOWED_WORDS.map(clean));

/** STRONG_WORDS as one pattern, found INSIDE a token (letters repeated or doubled as the list writes them). */
const STRONG = new RegExp(
  STRONG_WORDS.map((w) => runPattern(clean(w))).join('|'),
);
/** SPLIT_WORDS, whole, for the pieces of a word split by spaces. */
const SPLITTABLE = compile(SPLIT_WORDS).words;
/** A piece of a split word is this many letters or fewer, and a split word has at most this many pieces. */
const SPLIT_PIECE_MAX = 4;
const SPLIT_PIECES_MAX = 4;

let extraKey: string | undefined;
let extraCompiled: Compiled = compile([]);
/** The environment's additions, compiled once per value of the variable. */
function extra(): { entries: string[]; compiled: Compiled } {
  const raw = process.env.MODERATION_EXTRA_WORDS ?? '';
  const entries = raw
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && w.length <= 60);
  if (raw !== extraKey) {
    extraKey = raw;
    extraCompiled = compile(entries);
  }
  return { entries, compiled: extraCompiled };
}

/** What the admin reads (`GET /admin/moderation/words`): the built-in groups and the environment's additions. */
export function moderationWordList(): {
  total: number;
  builtIn: { category: string; language: string; words: string[] }[];
  fromEnvironment: string[];
} {
  const added = extra().entries;
  return {
    total: builtInWords().length + added.length,
    builtIn: BLOCKED_WORD_GROUPS.map((g) => ({
      category: g.category,
      language: g.language,
      words: [...g.words],
    })),
    fromEnvironment: added,
  };
}

interface Token {
  /** The token with punctuation at its edges taken off, folded to letters. Phrases and spelled-out words read these. */
  primary: string;
  /** Other readings of the same token (the whole of it folded, or with edge digits off); a single word is tried on each. */
  alts: string[];
}

const EDGE_SYMBOLS = /^[!$@*+]+|[!$@*+]+$/g;
const EDGE_DIGITS_AND_SYMBOLS = /^[0-9!$@*+]+|[0-9!$@*+]+$/g;

function foldToken(token: string): string {
  let s = '';
  for (const c of token) s += LEET[c] ?? c;
  return s;
}

/** The text as tokens, each folded to letters (a `*` stays as `*`). */
function tokensOf(text: string, emoji: EmojiAs): Token[] {
  let t = lettersOf(text, emoji);
  for (const phrase of ALLOWED) t = t.replace(phrase, ' ');
  const out: Token[] = [];
  for (const rough of t.split(/[^a-z0-9@$!*+]+/)) {
    if (!rough) continue;
    const primary = foldToken(rough.replace(EDGE_SYMBOLS, ''));
    // A token of nothing but punctuation ("!!!", "$") says nothing.
    if (primary === '') continue;
    const alts = [
      foldToken(rough),
      foldToken(rough.replace(EDGE_DIGITS_AND_SYMBOLS, '')),
    ].filter((a, i, all) => a !== '' && a !== primary && all.indexOf(a) === i);
    out.push({ primary, alts });
  }
  return out;
}

/** Does a token with `*` in it stand for a listed word? At least two real letters must stay. */
function maskedMatch(token: string, words: readonly string[]): string | null {
  if (!token.includes('*')) return null;
  const real = token.replace(/\*/g, '');
  if (real.length < 2 || !/^[a-z]+$/.test(real)) return null;
  const pattern = new RegExp(`^${token.replace(/\*/g, '[a-z]')}$`);
  return words.find((w) => pattern.test(w)) ?? null;
}

function firstHit(
  text: string,
  compiled: Compiled,
  emoji: EmojiAs,
  builtIn: boolean,
): string | null {
  const tokens = tokensOf(text, emoji);
  if (tokens.length === 0) return null;

  for (const token of tokens) {
    // A name or plain word the list would meet (blocked-words.ts, ALLOWED_WORDS): never refused.
    if (ALLOWED_TOKENS.has(token.primary)) continue;
    for (const reading of [token.primary, ...token.alts]) {
      if (compiled.words?.test(reading)) return reading;
      const masked = maskedMatch(reading, compiled.withEndings);
      if (masked) return masked;
      // The strong words, inside a longer word ("fuckyou", "bitchass", "muthafucka").
      if (builtIn) {
        const strong = STRONG.exec(reading);
        if (strong) return strong[0];
      }
    }
  }

  // Phrases: the tokens in order, one space between, whole words.
  const joined = tokens.map((t) => t.primary).join(' ');
  for (const phrase of compiled.phrases) {
    if (phrase.test(joined)) return phrase.source;
  }

  if (builtIn) {
    // A strong word split into short pieces: "fu ck", "fuc k", "f uck", "fu.ck", "f u ck".
    for (let i = 0; i < tokens.length; i += 1) {
      let glued = '';
      for (
        let j = i;
        j < Math.min(tokens.length, i + SPLIT_PIECES_MAX);
        j += 1
      ) {
        const piece = tokens[j].primary;
        if (piece.length > SPLIT_PIECE_MAX || !/^[a-z]+$/.test(piece)) break;
        glued += piece;
        if (j > i && SPLITTABLE?.test(glued)) return glued;
      }
    }
  }

  // A word spelled out one letter at a time.
  let run = '';
  const flush = (): string | null => {
    const letters = run;
    run = '';
    if (letters.length < 4) return null;
    if (builtIn) {
      const strong = STRONG.exec(letters);
      if (strong) return strong[0];
    }
    for (let i = 0; i < letters.length; i += 1) {
      for (let j = i + 4; j <= Math.min(letters.length, i + 24); j += 1) {
        const piece = letters.slice(i, j);
        if (compiled.words?.test(piece)) return piece;
      }
    }
    return null;
  };
  for (const { primary } of tokens) {
    if (primary.length === 1 && /[a-z]/.test(primary)) {
      run += primary;
      continue;
    }
    const hit = flush();
    if (hit) return hit;
  }
  return flush();
}

/**
 * The listed entry a text hits, or null. For specs and the admin only: the HTTP answer never carries it.
 */
export function blockedWordIn(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const looked =
    text.length > MAX_LOOKED_AT
      ? `${text.slice(0, MAX_LOOKED_AT / 2)} ${text.slice(-MAX_LOOKED_AT / 2)}`
      : text;
  // An emoji is read as nothing and as a gap, and a text is refused when either reading holds a word. Text with no emoji
  // reads the same both ways, so it is looked at once.
  const readings: EmojiAs[] =
    looked.search(EMOJI) === -1 ? ['join'] : ['join', 'space'];
  for (const emoji of readings) {
    const hit =
      firstHit(looked, BUILT_IN, emoji, true) ??
      firstHit(looked, extra().compiled, emoji, false);
    if (hit !== null) return hit;
  }
  return null;
}

type Field = string | readonly (string | null | undefined)[] | null | undefined;

/** True when any of the fields holds a listed word. */
export function containsBlockedContent(...fields: Field[]): boolean {
  for (const field of fields) {
    const texts = Array.isArray(field) ? field : [field];
    for (const text of texts as (string | null | undefined)[]) {
      if (blockedWordIn(text) !== null) return true;
    }
  }
  return false;
}

/**
 * Throws the refusal (400, `reason: { code: 'content_blocked', message }`) when any field holds a listed word. Call it
 * BEFORE anything is saved or charged. Fields that are missing or empty are skipped, so a partial update passes only the
 * ones it carries.
 */
export function assertContentAllowed(...fields: Field[]): void {
  if (!containsBlockedContent(...fields)) return;
  throw new BadRequestException({
    message: CONTENT_BLOCKED_MESSAGE,
    reason: { code: CONTENT_BLOCKED_CODE, message: CONTENT_BLOCKED_MESSAGE },
  });
}
