import { createHmac } from 'node:crypto';
import {
  accountNameMatches,
  bvnNameKeys,
  type NameBinding,
  nameWords,
  readBvnNameKeys,
  wordKey,
} from '../bvn-name';

/**
 * The BVN name as keyed word hashes bound to the person and the check, and
 * the comparison A21 shows as "matches your BVN" (task WALLET-14). Pure
 * functions: no database, no Fintava.
 */

const KEY = 'w14-test-name-key-0123456789abcdef0123';
const hmac = (key: string) => (value: string) =>
  createHmac('sha256', key).update(`name:${value}`).digest('hex');
const hash = hmac(KEY);

const ada: NameBinding = {
  wawuUserId: '11111111-1111-4111-8111-111111111111',
  verifiedAt: new Date('2026-10-03T09:00:00.000Z'),
};
const other: NameBinding = {
  wawuUserId: '22222222-2222-4222-8222-222222222222',
  verifiedAt: new Date('2026-10-03T09:00:00.000Z'),
};

const keysFor = (
  firstName: string | null,
  lastName: string | null,
  binding: NameBinding = ada,
) => bvnNameKeys({ firstName, lastName }, hash, binding);

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
  it('keeps one keyed hash per word, bound to the person and the check, never the words', () => {
    const keys = keysFor('Ada', 'Sandbox')!;
    expect(keys).toEqual({
      v: 2,
      check: hash(`check:${ada.wawuUserId}:${ada.verifiedAt.toISOString()}`),
      first: [hash(`${ada.wawuUserId}:${ada.verifiedAt.toISOString()}:ADA`)],
      last: [hash(`${ada.wawuUserId}:${ada.verifiedAt.toISOString()}:SANDBOX`)],
    });
    // Case-sensitive: the hex digits are lower case and can spell "ada".
    expect(JSON.stringify(keys)).not.toMatch(/ADA|SANDBOX|Ada|Sandbox/);
    for (const k of [keys.check, ...keys.first, ...keys.last]) {
      expect(k).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the same word hashes differently for two people, and for two checks of one person (defect 1)', () => {
    const a = keysFor('Ada', 'Okoro', ada)!;
    const b = keysFor('Ada', 'Okoro', other)!;
    const later = keysFor('Ada', 'Okoro', {
      ...ada,
      verifiedAt: new Date('2026-10-04T09:00:00.000Z'),
    })!;
    expect(a.first[0]).not.toBe(b.first[0]);
    expect(a.last[0]).not.toBe(b.last[0]);
    expect(a.first[0]).not.toBe(later.first[0]);
    // And no stored hash is what the word alone, unbound, hashes to.
    for (const plain of [hash('ADA'), hash('OKORO')]) {
      expect([...a.first, ...a.last, ...b.first, ...b.last]).not.toContain(
        plain,
      );
    }
  });

  it('is null when the first or the last name is missing or has no letters', () => {
    expect(keysFor(null, 'Sandbox')).toBeNull();
    expect(keysFor('Ada', '')).toBeNull();
    expect(keysFor('Ada', ' - ')).toBeNull();
  });
});

describe('readBvnNameKeys', () => {
  it('reads back the written shape for the same person, check and key', () => {
    const keys = keysFor('Ada', 'Sandbox');
    expect(
      readBvnNameKeys(JSON.parse(JSON.stringify(keys)), hash, ada),
    ).toEqual(keys);
  });

  it('anything else is null, never a mismatch: the round 1 scheme, another person or check, another key, a broken shape', () => {
    const keys = keysFor('Ada', 'Sandbox')!;
    // Round 1 stored `{ first, last }` of hash("WORD") with nothing bound.
    expect(
      readBvnNameKeys(
        { first: [hash('ADA')], last: [hash('SANDBOX')] },
        hash,
        ada,
      ),
    ).toBeNull();
    expect(readBvnNameKeys(keys, hash, other)).toBeNull();
    expect(
      readBvnNameKeys(keys, hash, {
        ...ada,
        verifiedAt: new Date('2026-10-04T09:00:00.000Z'),
      }),
    ).toBeNull();
    expect(readBvnNameKeys(keys, hmac(`${KEY}-rotated`), ada)).toBeNull();
    for (const bad of [
      null,
      'x',
      [],
      { ...keys, v: 1 },
      { ...keys, check: 'nope' },
      { ...keys, first: [] },
      { ...keys, first: ['ADA'] },
      { ...keys, last: [1] },
    ]) {
      expect(readBvnNameKeys(bad, hash, ada)).toBeNull();
    }
  });
});

describe('accountNameMatches (A21 "matches your BVN")', () => {
  const adaKeys = keysFor('Ada', 'Sandbox')!;
  const chidinma = keysFor('Chidinma Adaeze', 'Okoro')!;
  const matches = (keys: typeof adaKeys, name: string) =>
    accountNameMatches(keys, name, hash, ada);

  it.each([
    ['ADA SANDBOX'],
    ['Sandbox Ada'],
    ['SANDBOX ADA B'],
    ['sandbox, ada'],
    ['ÁDA SÁNDBOX'],
  ])('matches %p for Ada Sandbox', (name) => {
    expect(matches(adaKeys, name)).toBe(true);
  });

  it.each([
    ['SIMI MICHELLE'],
    ['ADA'],
    ['A SANDBOX'],
    ['ADAEZE SANDBOX'],
    ['SANDBOX VENTURES'],
    [''],
  ])('flags %p for Ada Sandbox', (name) => {
    expect(matches(adaKeys, name)).toBe(false);
  });

  it('needs every word of a two-word first name, but no middle name', () => {
    expect(matches(chidinma, 'OKORO CHIDINMA ADAEZE')).toBe(true);
    expect(matches(chidinma, 'OKORO CHIDINMA')).toBe(false);
  });

  it('compares only under the same person and check, and the same key', () => {
    expect(accountNameMatches(adaKeys, 'ADA SANDBOX', hash, other)).toBe(false);
    expect(
      accountNameMatches(adaKeys, 'ADA SANDBOX', hmac(`${KEY}x`), ada),
    ).toBe(false);
    expect(wordKey(hash, ada, 'ADA')).toBe(adaKeys.first[0]);
  });
});
