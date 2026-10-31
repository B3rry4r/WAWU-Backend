import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_PHRASES,
  BLOCKED_WORD_GROUPS,
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
 *  - case, accents (`ọ` is `o`) and the zero-width characters people hide in a word are ignored;
 *  - a letter written again and again: "fuuuuck";
 *  - simple l33t: `0 1 3 4 5 7 @ $ !` stand for letters ("sh1t", "a$$hole" if listed), `+` for t;
 *  - a masked letter: "f*ck" (at least two real letters must stay, so "**" matches nothing);
 *  - a word spelled out: "f u c k", "f.u.c.k", "f-u-c-k" (four or more single letters in a row).
 * A few innocent phrases that hold a listed word are taken out first (blocked-words.ts, ALLOWED_PHRASES).
 *
 * The built-in list can be added to without a release: `MODERATION_EXTRA_WORDS`, a comma-separated list, read on each
 * call (so a restart is the only step). It can only add; it cannot take a built-in word out.
 */

/** The `reason.code` of the refusal. The app keys on this, never on the words. */
export const CONTENT_BLOCKED_CODE = 'content_blocked';

/** One sentence, no em-dash: the app shows it as it is. The product's name is "Who Made This" (R-37). */
export const CONTENT_BLOCKED_MESSAGE =
  "That has words we don't allow on Who Made This. Change them and try again.";

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
};

/** The longest text looked at, so a huge body cannot make a request slow. Longer text is checked in this much from its start and its end. */
const MAX_LOOKED_AT = 20_000;

function lettersOf(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ɗƙɓƴøßđłæœı]/gu, (c) => SPECIAL[c] ?? c)
    .replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '')
    .toLowerCase()
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
const ALLOWED = ALLOWED_PHRASES.map(clean);

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
function tokensOf(text: string): Token[] {
  let t = lettersOf(text);
  for (const phrase of ALLOWED) {
    if (phrase) t = t.split(phrase).join(' ');
  }
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

function firstHit(text: string, compiled: Compiled): string | null {
  const tokens = tokensOf(text);
  if (tokens.length === 0) return null;

  for (const token of tokens) {
    for (const reading of [token.primary, ...token.alts]) {
      if (compiled.words?.test(reading)) return reading;
      const masked = maskedMatch(reading, compiled.withEndings);
      if (masked) return masked;
    }
  }

  // Phrases: the tokens in order, one space between, whole words.
  const joined = tokens.map((t) => t.primary).join(' ');
  for (const phrase of compiled.phrases) {
    if (phrase.test(joined)) return phrase.source;
  }

  // A word spelled out one letter at a time.
  let run = '';
  const flush = (): string | null => {
    const letters = run;
    run = '';
    if (letters.length < 4) return null;
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
  return firstHit(looked, BUILT_IN) ?? firstHit(looked, extra().compiled);
}

type Field = string | readonly string[] | null | undefined;

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
