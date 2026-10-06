import { AD_ARTWORK_URL_MAX } from '../../ads/ads-text-limits';

/**
 * What text may appear on a sponsored card, decided by Unicode category rather
 * than by a list of code points (ADS-06).
 *
 * The database's own check (ADS-03) refuses a value made only of the 139 code
 * points it lists; any other invisible code point gets past it. This is the
 * floor the admin routes add: text is normalised, trimmed, and accepted only
 * if every character in it is one a person can see, or a space, or a mark that
 * sits on a visible character.
 *
 * Rules, in the order they are applied:
 *  - Normalised to NFC, runs of space separators (no-break space, ideographic
 *    space and the rest of Zs) become one ordinary space, and the ends are
 *    trimmed.
 *  - One line: no control character (Cc), no line or paragraph separator.
 *  - No character that is drawn as nothing: format characters (Cf: zero-width
 *    space, bidirectional overrides, tag characters U+E0000 to U+E007F, soft
 *    hyphen) except the joiner and non-joiner inside a word; unassigned,
 *    private-use and lone surrogate code points; the blank-looking letters and
 *    symbols (U+2800 braille blank, U+FFFC object replacement, U+FFFD, the
 *    Hangul and Khmer fillers, U+034F).
 *  - A combining mark (Mn, Mc, Me) must sit on a visible character: a mark at
 *    the start, or after a space, is refused, so a card cannot be made to
 *    draw an accent on the label next to it.
 *  - A joiner or non-joiner needs a visible character on each side.
 *  - No em dash or en dash (R-5: nothing a user reads carries one), the same
 *    rule as the notification composer.
 *  - At least one visible character (a letter, number, punctuation or symbol).
 */

const MAX_MESSAGE = (field: string, max: number) =>
  `${field} must be at most ${max} characters.`;

const ZWNJ = 0x200c;
const ZWJ = 0x200d;

/** Drawn as nothing, though Unicode files them under letters, symbols or marks. */
const BLANK_LOOKING = new Set<number>([
  0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x2800, 0x3164, 0xffa0, 0xfffc,
  0xfffd,
]);

const CONTROL = /^\p{Cc}$/u;
const NEVER_ASSIGNED = /^[\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]$/u;
const FORMAT = /^\p{Cf}$/u;
const MARK = /^\p{M}$/u;
const SPACE = /^\p{Zs}$/u;
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

export type AdTextResult =
  { ok: true; value: string } | { ok: false; message: string };

/** NFC, one ordinary space for each run of spaces, ends trimmed. Idempotent. */
export function normaliseAdText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\p{Zs}+/gu, ' ')
    .trim();
}

/** Normalises `raw` and says whether the result may go on a card. */
export function checkAdText(
  raw: string,
  field: string,
  max: number,
  options: { min?: number } = {},
): AdTextResult {
  const value = normaliseAdText(raw);
  const chars = [...value];
  if (chars.length === 0) {
    return { ok: false, message: `${field} is required.` };
  }

  let visible = 0;
  // True while the previous character is a visible one or a mark on one.
  let onVisible = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const cp = ch.codePointAt(0) ?? 0;

    if (cp === 0x2014 || cp === 0x2013) {
      return {
        ok: false,
        message: `${field} must not contain an em dash or en dash. Use a comma, a colon, or two sentences.`,
      };
    }
    if (CONTROL.test(ch) || NEVER_ASSIGNED.test(ch)) {
      return {
        ok: false,
        message: `${field} must be one line of text without control or unassigned characters.`,
      };
    }
    if (BLANK_LOOKING.has(cp)) {
      return {
        ok: false,
        message: `${field} contains a character that is drawn as nothing.`,
      };
    }
    if (FORMAT.test(ch)) {
      if (cp !== ZWJ && cp !== ZWNJ) {
        return {
          ok: false,
          message: `${field} contains a hidden formatting character.`,
        };
      }
      const next = chars[i + 1];
      if (!onVisible || next === undefined || !VISIBLE.test(next)) {
        return {
          ok: false,
          message: `${field} contains a joiner that is not between two visible characters.`,
        };
      }
      onVisible = false;
      continue;
    }
    if (SPACE.test(ch)) {
      onVisible = false;
      continue;
    }
    if (MARK.test(ch)) {
      if (!onVisible) {
        return {
          ok: false,
          message: `${field} contains a combining mark that is not on a character.`,
        };
      }
      continue;
    }
    if (VISIBLE.test(ch)) {
      visible += 1;
      onVisible = true;
      continue;
    }
    return {
      ok: false,
      message: `${field} contains a character that cannot be shown.`,
    };
  }

  if (visible === 0) {
    return { ok: false, message: `${field} has no visible character.` };
  }
  if (chars.length > max) {
    return { ok: false, message: MAX_MESSAGE(field, max) };
  }
  if (options.min !== undefined && chars.length < options.min) {
    return {
      ok: false,
      message: `${field} must be at least ${options.min} characters.`,
    };
  }
  return { ok: true, value };
}

const HOST =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const UNSAFE_URL_CHARS = /[\s<>"'`\\^{}|]/u;

/**
 * An artwork link: https, a real host name (no address, no localhost), no
 * credentials, no space or markup character, within the length bound. The
 * admin supplies the link, as for Event.bannerUrl and a notification
 * campaign's picture: this backend has no admin-side upload route.
 */
export function checkArtworkUrl(raw: string): AdTextResult {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, message: 'artworkUrl is required when it is sent.' };
  }
  if (value.length > AD_ARTWORK_URL_MAX) {
    return {
      ok: false,
      message: MAX_MESSAGE('artworkUrl', AD_ARTWORK_URL_MAX),
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: 'artworkUrl must be a web link.' };
  }
  if (
    url.protocol !== 'https:' ||
    !value.toLowerCase().startsWith('https://') ||
    url.username !== '' ||
    url.password !== '' ||
    UNSAFE_URL_CHARS.test(value) ||
    !HOST.test(url.hostname)
  ) {
    return {
      ok: false,
      message:
        'artworkUrl must be an https link to a public host, without a password or spaces.',
    };
  }
  return { ok: true, value };
}

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * An instant written in UTC and nothing else: `2026-10-18T09:00:00Z` or with up
 * to three decimals. An offset (`+01:00`), a date without a time, or a day that
 * does not exist (31 February) gives null.
 */
export function parseUtcInstant(raw: string): Date | null {
  const m = INSTANT.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  date.setUTCHours(Number(h), Number(mi), Number(s), ms);
  const same =
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d) &&
    date.getUTCHours() === Number(h) &&
    date.getUTCMinutes() === Number(mi) &&
    date.getUTCSeconds() === Number(s);
  return same ? date : null;
}
