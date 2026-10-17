import { randomInt } from 'node:crypto';
import { REFERRAL_CODE } from './referral-config';

/** `Lennox` or ` wawu/r/lennox ` to `LENNOX`; null when no code can be read from it. */
export function normalizeCode(raw: string): string | null {
  const tail = raw.trim().split('/').pop() ?? '';
  const code = tail.trim().toUpperCase();
  if (
    code.length < REFERRAL_CODE.minLength ||
    code.length > REFERRAL_CODE.maxLength ||
    !/^[A-Z0-9]+$/.test(code)
  )
    return null;
  return code;
}

/** The letters of a first name, upper case, accents dropped, at most `nameLength`. */
export function nameStem(firstName: string | null | undefined): string {
  const letters = (firstName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return letters.slice(0, REFERRAL_CODE.nameLength);
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < REFERRAL_CODE.randomLength; i++)
    out += REFERRAL_CODE.alphabet[randomInt(REFERRAL_CODE.alphabet.length)];
  return out;
}

/**
 * The codes to try for a person, best first: their name, then their name and
 * a few digits, then a random one. `attempt` counts from 0.
 */
export function codeCandidate(stem: string, attempt: number): string {
  const named = stem.length >= REFERRAL_CODE.minLength;
  if (named && attempt === 0) return stem;
  if (named && attempt < REFERRAL_CODE.nameAttempts) {
    const digits = String(randomInt(10 ** attempt, 10 ** (attempt + 1)));
    return `${stem}${digits}`.slice(0, REFERRAL_CODE.maxLength);
  }
  return randomCode();
}
