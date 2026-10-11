import {
  paymentKindOf,
  PLAN_PAYMENT_KINDS,
  targetIdOf,
  TARGET_ID_MAX_LENGTH,
  termsOf,
  type PurchaseTerms,
} from '../plan-purchase-terms';

/**
 * TIER-03: the payment's target carries the terms. What is written is read
 * back to the same terms, and nothing else reads as terms.
 */

const simple = (kind: 'tier' | 'renew', tierId: string, bump = false) =>
  ({ kind, tierId, fromTierId: null, bump }) satisfies PurchaseTerms;
const upgrade = (fromTierId: string, tierId: string, bump = false) =>
  ({ kind: 'upgrade', tierId, fromTierId, bump }) satisfies PurchaseTerms;

describe('the terms in a tier payment (TIER-03)', () => {
  it('names the payment kind from the bump, and nothing else', () => {
    expect(paymentKindOf(false)).toBe('tier');
    expect(paymentKindOf(true)).toBe('tier_bump');
    expect([...PLAN_PAYMENT_KINDS]).toEqual(['tier', 'tier_bump']);
  });

  it.each([
    [simple('tier', 'founding'), 'tier-founding'],
    [simple('renew', 'plus'), 'renew-plus'],
    [upgrade('verify', 'founding'), 'upgrade-verify-founding'],
    [simple('tier', 'verify_two'), 'tier-verify_two'],
  ])(
    'writes %j as %s and reads it back, with and without the bump',
    (terms, id) => {
      expect(targetIdOf(terms)).toBe(id);
      expect(termsOf('tier', id)).toEqual(terms);
      expect(termsOf('tier_bump', id)).toEqual({ ...terms, bump: true });
    },
  );

  it('writes no target for an upgrade without a tier to move from', () => {
    expect(
      targetIdOf({
        kind: 'upgrade',
        tierId: 'founding',
        fromTierId: null,
        bump: false,
      }),
    ).toBeNull();
  });

  it('writes no target that is not a valid payment target', () => {
    expect(targetIdOf(simple('tier', 'Founding'))).toBeNull();
    expect(targetIdOf(simple('tier', 'a-b'))).toBeNull();
    expect(targetIdOf(simple('tier', ''))).toBeNull();
    expect(
      targetIdOf(upgrade('verify', 'x'.repeat(TARGET_ID_MAX_LENGTH))),
    ).toBeNull();
    const longest = 'a'.repeat(TARGET_ID_MAX_LENGTH - 'tier-'.length);
    expect(targetIdOf(simple('tier', longest))).toHaveLength(
      TARGET_ID_MAX_LENGTH,
    );
    expect(targetIdOf(simple('tier', `${longest}a`))).toBeNull();
  });

  it.each([
    'founding',
    'tier',
    'tier-',
    'tier-Founding',
    'tier-a-b',
    'renew-a-b',
    'upgrade-founding',
    'upgrade--founding',
    'upgrade-a-b-c',
    'downgrade-a-b',
    'TIER-founding',
    ' tier-founding',
    'tier-founding ',
    'tier-founding\n',
    '',
  ])('reads %j as no terms', (target) => {
    expect(termsOf('tier', target)).toBeNull();
    expect(termsOf('tier_bump', target)).toBeNull();
  });

  it('reads only the plan kinds', () => {
    for (const kind of [
      'content_unlock',
      'tip',
      'credit_pack',
      'verification',
      'bill',
      'TIER',
      '',
    ])
      expect(termsOf(kind, 'tier-founding')).toBeNull();
  });
});
