import {
  readStoredClaimResult,
  type StoredClaimResult,
} from '../waitlist-claim-result';

/**
 * JOIN-03 round 3 (N13, the round 2 survivors Y7b and Y7c): the reader of the
 * answer a claim kept. A repeat of the code is answered from it, so it must
 * take every answer this code writes and none that it does not.
 */
describe('readStoredClaimResult', () => {
  const written: StoredClaimResult = {
    offerName: 'Verify',
    days: 30,
    extended: false,
    pointsGranted: 100,
    pointsExpireAt: '2027-01-08T10:00:00.000Z',
  };

  it('reads an answer with points and one without (a points end of null)', () => {
    expect(readStoredClaimResult(written)).toEqual(written);
    const none = { ...written, pointsGranted: 0, pointsExpireAt: null };
    expect(readStoredClaimResult(none)).toEqual(none);
  });

  it('reads back only the five fields, whatever else the column holds', () => {
    expect(
      readStoredClaimResult({ ...written, extra: 'x', sub: 'u1' }),
    ).toEqual(written);
  });

  it('refuses a day or point count that is not a whole number', () => {
    for (const bad of [
      30.5,
      0.1,
      NaN,
      Infinity,
      -Infinity,
      '30',
      null,
      undefined,
    ])
      expect(readStoredClaimResult({ ...written, days: bad })).toBeNull();
    for (const bad of [100.25, NaN, Infinity, '100', null, undefined])
      expect(
        readStoredClaimResult({ ...written, pointsGranted: bad }),
      ).toBeNull();
  });

  it('refuses a points end that is neither text nor null', () => {
    for (const bad of [1760000000000, undefined, {}, [], true])
      expect(
        readStoredClaimResult({ ...written, pointsExpireAt: bad }),
      ).toBeNull();
  });

  it('refuses a name or flag of the wrong type', () => {
    expect(readStoredClaimResult({ ...written, offerName: 42 })).toBeNull();
    expect(
      readStoredClaimResult({ ...written, offerName: undefined }),
    ).toBeNull();
    expect(readStoredClaimResult({ ...written, extended: 'no' })).toBeNull();
    expect(
      readStoredClaimResult({ ...written, extended: undefined }),
    ).toBeNull();
  });

  it('refuses a column that is not an object', () => {
    for (const bad of [null, undefined, 'x', 7, true, [], [written], {}])
      expect(readStoredClaimResult(bad)).toBeNull();
  });
});
