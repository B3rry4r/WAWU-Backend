import type { FintavaBvnIdentity } from '../../fintava/fintava.interface';

/**
 * The BVN name, kept only as keyed hashes of its words (task WALLET-14), so
 * a payout account's name can be compared with it (A21, "matches your BVN")
 * without the name itself ever being stored. KYC-01 stores nothing else of
 * the BVN record (docs/contract/CONVENTIONS.md section 8); the hashes are
 * written with every passed check, beside the keyed hash of the BVN.
 *
 * A word is the name in capital Latin letters, accents taken off, split on
 * anything that is not a letter: "Adébáyọ̀ Mary-Jane" is ADEBAYO, MARY, JANE.
 */

/** `WalletIdentity.bvnNameKeys`: the keyed hash of each word, per part. */
export interface BvnNameKeys {
  first: string[];
  last: string[];
}

/** The words of a name, as compared: capitals A to Z only, no accents, no repeats. */
export function nameWords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const plain = raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .trim();
  if (plain === '') return [];
  return [...new Set(plain.split(' '))];
}

/**
 * The keys to store for a passed check, or null when Fintava gave no first
 * name or no last name we can read (then nothing can be compared, and the
 * payout account says so with `matchesBvnName: null`).
 */
export function bvnNameKeys(
  identity: Pick<FintavaBvnIdentity, 'firstName' | 'lastName'>,
  hash: (word: string) => string,
): BvnNameKeys | null {
  const first = nameWords(identity.firstName);
  const last = nameWords(identity.lastName);
  if (first.length === 0 || last.length === 0) return null;
  return { first: first.map(hash), last: last.map(hash) };
}

/** Reads the stored column back; anything not in the written shape is "no BVN name". */
export function readBvnNameKeys(value: unknown): BvnNameKeys | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { first, last } = value as Record<string, unknown>;
  const hexList = (v: unknown): v is string[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x));
  if (!hexList(first) || !hexList(last)) return null;
  return { first, last };
}

/**
 * Whether a bank's account name is the BVN name: every word of the BVN's
 * first name and every word of its last name is a word of the account name,
 * in any order (banks write "OKORO CHIDINMA ADAEZE" as often as "Chidinma
 * Okoro"). The middle name is not needed: banks often leave it out. An
 * initial in place of a name does not match, so such an account is flagged
 * rather than passed. Default (agent), owner may override.
 */
export function accountNameMatches(
  keys: BvnNameKeys,
  accountName: string,
  hash: (word: string) => string,
): boolean {
  const words = new Set(nameWords(accountName).map(hash));
  if (words.size === 0) return false;
  return [...keys.first, ...keys.last].every((key) => words.has(key));
}
