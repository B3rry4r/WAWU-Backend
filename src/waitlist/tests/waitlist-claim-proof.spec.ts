import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import {
  holdsRegisteredContact,
  readAccessCode,
  verifiedContactsOf,
} from '../waitlist-claim-proof';

/**
 * JOIN-03: what counts as a PROVEN contact for the claim, without a server.
 * The HTTP specs (waitlist-claim.contract.spec.ts) run the same rules end to
 * end; this file pins each one on its own.
 */
const claims = (over: Record<string, unknown> = {}): WawuJwtClaims =>
  ({
    sub: 'u1',
    email: 'Ada@Example.test',
    phone: '08031234567',
    ...over,
  }) as unknown as WawuJwtClaims;

const PHONE = '+2348031234567';
const hub = (over: Record<string, unknown> = {}) => ({
  verifiedPhone: PHONE,
  bvnVerifiedAt: new Date('2026-10-01T10:00:00.000Z'),
  ...over,
});

describe('which contacts an account has proven (JOIN-03)', () => {
  it('proves nothing from a typed phone and email: the token alone is not proof', () => {
    expect(verifiedContactsOf(claims())).toEqual({ phones: [], email: null });
    expect(
      verifiedContactsOf(
        claims({ phoneVerified: false, emailVerified: false }),
      ),
    ).toEqual({ phones: [], email: null });
  });

  it('counts a flag only when it is exactly true', () => {
    for (const flag of ['true', 1, 'yes', {}, [], null])
      expect(
        verifiedContactsOf(
          claims({ phoneVerified: flag, emailVerified: flag }),
        ),
      ).toEqual({ phones: [], email: null });
  });

  it('proves the phone when WAWU ID says the phone was proven, written as E.164 and the email in lower case', () => {
    expect(verifiedContactsOf(claims({ phoneVerified: true }))).toEqual({
      phones: [PHONE],
      email: null,
    });
    expect(verifiedContactsOf(claims({ emailVerified: true }))).toEqual({
      phones: [],
      email: 'ada@example.test',
    });
  });

  it('proves a phone no flag mentions when the Hub holds a passed BVN check for exactly the number the account has now', () => {
    expect(verifiedContactsOf(claims(), hub())).toEqual({
      phones: [PHONE],
      email: null,
    });
    // Once, however many ways it is proven.
    expect(verifiedContactsOf(claims({ phoneVerified: true }), hub())).toEqual({
      phones: [PHONE],
      email: null,
    });
  });

  it("never counts the Hub's phone without a passed check, without a number, or for a number the account has given up", () => {
    expect(
      verifiedContactsOf(claims(), hub({ bvnVerifiedAt: null })).phones,
    ).toEqual([]);
    expect(
      verifiedContactsOf(claims(), hub({ verifiedPhone: null })).phones,
    ).toEqual([]);
    expect(
      verifiedContactsOf(claims(), hub({ verifiedPhone: '+2348099990000' }))
        .phones,
    ).toEqual([]);
    expect(verifiedContactsOf(claims({ phone: '' }), hub()).phones).toEqual([]);
  });

  it('reads a phone or email that is not text as no contact, never a crash', () => {
    expect(
      verifiedContactsOf(
        claims({
          phone: 8031234567,
          email: null,
          phoneVerified: true,
          emailVerified: true,
        }),
      ),
    ).toEqual({ phones: [], email: null });
  });
});

describe('a proven contact against a registration (JOIN-03)', () => {
  const registered = { phone: PHONE, email: 'ada@example.test' };

  it('holds the registration by its phone or by its email, and by nothing else', () => {
    expect(
      holdsRegisteredContact({ phones: [PHONE], email: null }, registered),
    ).toBe(true);
    expect(
      holdsRegisteredContact(
        { phones: [], email: 'ada@example.test' },
        registered,
      ),
    ).toBe(true);
    expect(
      holdsRegisteredContact(
        { phones: ['+2348099990000'], email: 'x@example.test' },
        registered,
      ),
    ).toBe(false);
    expect(
      holdsRegisteredContact({ phones: [], email: null }, registered),
    ).toBe(false);
  });
});

describe('the access code as the page shows it (JOIN-03)', () => {
  it('reads 8 hex digits however they are written and nothing else', () => {
    expect(readAccessCode('5F6C 15E4')).toBe('5F6C15E4');
    expect(readAccessCode(' 5f6c-15e4 ')).toBe('5F6C15E4');
    expect(readAccessCode('5F6C_15E4')).toBe('5F6C15E4');
    for (const bad of ['', '5F6C15E', '5F6C15E45', '5F6C 15EG', '0x5F6C15E4'])
      expect(readAccessCode(bad)).toBeNull();
  });
});
