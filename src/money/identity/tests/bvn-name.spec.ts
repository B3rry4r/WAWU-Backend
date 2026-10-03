import { createHmac } from 'node:crypto';
import {
  accountNameMatches,
  bvnNameKeys,
  nameWords,
  readBvnNameKeys,
} from '../bvn-name';

/**
 * The BVN name as keyed word hashes, and the comparison A21 shows as
 * "matches your BVN" (task WALLET-14). Pure functions: no database, no
 * Fintava.
 */

const KEY = 'w14-test-name-key-0123456789abcdef0123';
const hash = (word: string) =>
  createHmac('sha256', KEY).update(`name:${word}`).digest('hex');

const keysFor = (firstName: string | null, lastName: string | null) =>
  bvnNameKeys({ firstName, lastName }, hash);

describe('nameWords', () => {
  it('reads capitals A to Z only, accents off, split on anything else, no repeats', () => {
    expect(nameWords('Adébáyọ̀  Mary-Jane')).toEqual([
      'ADEBAYO',
      'MARY',
      'JANE',
    ]);
    expect(nameWords("o'neil OKORO, okoro")).toEqual(['O', 'NEIL', 'OKORO']);
    expect(nameWords('  ')).toEqual([]);
    expect(nameWords(null)).toEqual([]);
    expect(nameWords('123 ---')).toEqual([]);
  });
});

describe('bvnNameKeys', () => {
  it('keeps one keyed hash per word of the first and last name, never the words', () => {
    const keys = keysFor('Ada', 'Sandbox')!;
    expect(keys).toEqual({ first: [hash('ADA')], last: [hash('SANDBOX')] });
    // Case-sensitive: the hex digits are lower case and can spell "ada".
    expect(JSON.stringify(keys)).not.toMatch(/ADA|SANDBOX|Ada|Sandbox/);
    for (const k of [...keys.first, ...keys.last]) {
      expect(k).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is null when the first or the last name is missing or has no letters', () => {
    expect(keysFor(null, 'Sandbox')).toBeNull();
    expect(keysFor('Ada', '')).toBeNull();
    expect(keysFor('Ada', ' - ')).toBeNull();
  });
});

describe('readBvnNameKeys', () => {
  it('reads back only the written shape', () => {
    const keys = keysFor('Ada', 'Sandbox');
    expect(readBvnNameKeys(JSON.parse(JSON.stringify(keys)))).toEqual(keys);
    for (const bad of [
      null,
      'x',
      [],
      { first: [], last: [hash('A')] },
      { first: ['ADA'], last: [hash('A')] },
      { first: [hash('A')] },
      { first: [hash('A')], last: [1] },
    ]) {
      expect(readBvnNameKeys(bad)).toBeNull();
    }
  });
});

describe('accountNameMatches (A21 "matches your BVN")', () => {
  const ada = keysFor('Ada', 'Sandbox')!;
  const chidinma = keysFor('Chidinma Adaeze', 'Okoro')!;

  it.each([
    ['ADA SANDBOX'],
    ['Sandbox Ada'],
    ['SANDBOX ADA B'],
    ['sandbox, ada'],
    ['ÁDA SÁNDBOX'],
  ])('matches %p for Ada Sandbox', (name) => {
    expect(accountNameMatches(ada, name, hash)).toBe(true);
  });

  it.each([
    ['SIMI MICHELLE'],
    ['ADA'],
    ['A SANDBOX'],
    ['ADAEZE SANDBOX'],
    ['SANDBOX VENTURES'],
    [''],
  ])('flags %p for Ada Sandbox', (name) => {
    expect(accountNameMatches(ada, name, hash)).toBe(false);
  });

  it('needs every word of a two-word first name, but no middle name', () => {
    expect(accountNameMatches(chidinma, 'OKORO CHIDINMA ADAEZE', hash)).toBe(
      true,
    );
    expect(accountNameMatches(chidinma, 'OKORO CHIDINMA', hash)).toBe(false);
  });

  it('a different key never matches (the words are compared as keyed hashes)', () => {
    const other = (word: string) =>
      createHmac('sha256', `${KEY}x`).update(`name:${word}`).digest('hex');
    expect(accountNameMatches(ada, 'ADA SANDBOX', other)).toBe(false);
  });
});
