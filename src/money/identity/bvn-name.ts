import type { ProviderIdentity } from '../../wallet-provider/wallet-provider.interface';

/**
 * The BVN name, kept only as keyed hashes of its words (task WALLET-14), so
 * a payout account's name can be compared with it (A21, "matches your BVN")
 * without the name itself ever being stored. KYC-01 stores nothing else of
 * the BVN record (docs/contract/CONVENTIONS.md section 8); the hashes are
 * written with every passed check, beside the keyed hash of the BVN.
 *
 * Each word's hash is bound to the person and to the check that wrote it
 * (round 2, verifier defect 1): `name:<wawuUserId>:<check time>:<WORD>`
 * under IDENTITY_HASH_KEY. Only one person's keys are ever compared with
 * that person's own payout account, so nothing needs a word to hash the
 * same for two people; and because it never does, a reader of the database
 * without the key cannot line a hash up with a name stored in plain text
 * elsewhere (a payout account, a beneficiary, a wallet's account name).
 *
 * A word is the name in capital Latin letters, accents taken off, split on
 * anything that is not a letter: "Adébáyọ̀ Mary-Jane" is ADEBAYO, MARY, JANE.
 */

/** The version of the stored shape; anything else reads as "no BVN name". */
export const BVN_NAME_KEYS_VERSION = 2;

/** `WalletIdentity.bvnNameKeys`: the keyed hash of each word, per part. */
export interface BvnNameKeys {
  v: typeof BVN_NAME_KEYS_VERSION;
  /**
   * A keyed hash of the person and the check alone. Recomputed on every
   * read: when it differs (IDENTITY_HASH_KEY changed, or the row belongs to
   * another check) the keys cannot be compared, which reads as "no BVN
   * name" (`null`), never as a mismatch.
   */
  check: string;
  first: string[];
  last: string[];
}

/** HMAC-SHA256 under IDENTITY_HASH_KEY, as IdentityHasher.hash('name', ...) gives it. */
export type NameHash = (value: string) => string;

/** One person's one passed check: what every word's hash is bound to. */
export interface NameBinding {
  wawuUserId: string;
  /** WalletIdentity.bvnVerifiedAt of the check that kept the keys. */
  verifiedAt: Date;
}

const scope = (b: NameBinding) =>
  `${b.wawuUserId}:${b.verifiedAt.toISOString()}`;

/** The hash of one word, for this person and this check. */
export function wordKey(hash: NameHash, b: NameBinding, word: string): string {
  return hash(`${scope(b)}:${word}`);
}

/** The marker that ties stored keys to this person, this check and this key. */
export function checkKey(hash: NameHash, b: NameBinding): string {
  return hash(`check:${scope(b)}`);
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
  identity: Pick<ProviderIdentity, 'firstName' | 'lastName'>,
  hash: NameHash,
  binding: NameBinding,
): BvnNameKeys | null {
  const first = nameWords(identity.firstName);
  const last = nameWords(identity.lastName);
  if (first.length === 0 || last.length === 0) return null;
  const key = (w: string) => wordKey(hash, binding, w);
  return {
    v: BVN_NAME_KEYS_VERSION,
    check: checkKey(hash, binding),
    first: first.map(key),
    last: last.map(key),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Reads the stored column back for this person and check. Anything not in
 * the written shape, the first scheme's `{ first, last }` (round 1, not
 * bound to the person), or keys whose marker does not recompute (another
 * key, another check) is "no BVN name": null, never a false match.
 */
export function readBvnNameKeys(
  value: unknown,
  hash: NameHash,
  binding: NameBinding,
): BvnNameKeys | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { v, check, first, last } = value as Record<string, unknown>;
  const hexList = (x: unknown): x is string[] =>
    Array.isArray(x) &&
    x.length > 0 &&
    x.every((h) => typeof h === 'string' && HEX64.test(h));
  if (v !== BVN_NAME_KEYS_VERSION || typeof check !== 'string') return null;
  if (!hexList(first) || !hexList(last)) return null;
  if (check !== checkKey(hash, binding)) return null;
  return { v: BVN_NAME_KEYS_VERSION, check, first, last };
}

/**
 * Whether a bank's account name is the BVN name: every word of the BVN's
 * first name and every word of its last name is a word of the account name,
 * in any order (banks write "OKORO CHIDINMA ADAEZE" as often as "Chidinma
 * Okoro"). The middle name is not needed: banks often leave it out. An
 * initial in place of a name does not match, so such an account is flagged
 * rather than passed. Default (agent), owner may override (the task file's
 * owner questions list the edge cases).
 */
export function accountNameMatches(
  keys: BvnNameKeys,
  accountName: string,
  hash: NameHash,
  binding: NameBinding,
): boolean {
  const words = new Set(
    nameWords(accountName).map((w) => wordKey(hash, binding, w)),
  );
  if (words.size === 0) return false;
  return [...keys.first, ...keys.last].every((key) => words.has(key));
}
