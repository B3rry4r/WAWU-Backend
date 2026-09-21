import {
  deriveVerificationState,
  holdsAnyTick,
  oneYearFrom,
  unverified,
} from '../verification-state';

/**
 * The derivation, on its own.
 *
 * `verified` is decided in exactly one function and every read path calls it,
 * so these four cases are the whole of the rule: never granted, live, lapsed,
 * and perpetual. If one of these is wrong, every tick on the platform is
 * wrong in the same way.
 */
const NOW = new Date('2026-09-21T12:00:00.000Z');

const NONE = {
  creatorVerifiedAt: null,
  creatorVerifiedUntil: null,
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};

describe('deriveVerificationState', () => {
  it('reports no tick at all for an account that has never been verified', () => {
    const state = deriveVerificationState(NONE, NOW);
    expect(state).toEqual({
      creator: { verified: false, expiresAt: null },
      professional: { verified: false, expiresAt: null },
    });
  });

  it('reports no tick for a row that does not exist', () => {
    expect(deriveVerificationState(null, NOW)).toEqual(unverified());
    expect(deriveVerificationState(undefined, NOW)).toEqual(unverified());
  });

  it('verifies a tick whose term has not run out, and reports the date', () => {
    const state = deriveVerificationState(
      {
        ...NONE,
        creatorVerifiedAt: new Date('2026-03-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2027-03-01T00:00:00.000Z'),
      },
      NOW,
    );
    expect(state.creator).toEqual({
      verified: true,
      expiresAt: '2027-03-01T00:00:00.000Z',
    });
    // Independent: buying one does not confer the other.
    expect(state.professional).toEqual({ verified: false, expiresAt: null });
  });

  it('does not verify a tick whose term has run out, but still reports the date', () => {
    const state = deriveVerificationState(
      {
        ...NONE,
        creatorVerifiedAt: new Date('2025-03-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2026-03-01T00:00:00.000Z'),
      },
      NOW,
    );
    expect(state.creator).toEqual({
      verified: false,
      // Withheld, a client could not say "expired on 1 March" at all.
      expiresAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('treats a null expiry beside a real grant date as perpetual', () => {
    const state = deriveVerificationState(
      {
        ...NONE,
        professionalVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
        professionalVerifiedUntil: null,
      },
      NOW,
    );
    expect(state.professional).toEqual({ verified: true, expiresAt: null });
  });

  it('expires exactly on the boundary rather than a moment after it', () => {
    const boundary = {
      ...NONE,
      creatorVerifiedAt: new Date('2025-09-21T12:00:00.000Z'),
      creatorVerifiedUntil: NOW,
    };
    expect(deriveVerificationState(boundary, NOW).creator.verified).toBe(false);
    expect(
      deriveVerificationState(boundary, new Date(NOW.getTime() - 1)).creator
        .verified,
    ).toBe(true);
  });

  it('carries both ticks at once, and never picks a winner', () => {
    const state = deriveVerificationState(
      {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2027-01-01T00:00:00.000Z'),
        professionalVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
        professionalVerifiedUntil: null,
      },
      NOW,
    );
    expect(state.creator.verified).toBe(true);
    expect(state.professional.verified).toBe(true);
  });

  it('hands back a fresh object each time, so one response cannot mutate another', () => {
    const a = unverified();
    const b = unverified();
    a.creator.verified = true;
    expect(b.creator.verified).toBe(false);
  });
});

describe('holdsAnyTick', () => {
  it('is true for either tick and false for neither', () => {
    expect(holdsAnyTick(unverified())).toBe(false);
    expect(
      holdsAnyTick(
        deriveVerificationState(
          {
            ...NONE,
            creatorVerifiedAt: NOW,
            creatorVerifiedUntil: new Date('2027-09-21T12:00:00.000Z'),
          },
          NOW,
        ),
      ),
    ).toBe(true);
    expect(
      holdsAnyTick(
        deriveVerificationState(
          { ...NONE, professionalVerifiedAt: NOW, professionalVerifiedUntil: null },
          NOW,
        ),
      ),
    ).toBe(true);
  });

  it('is false once the only tick held has lapsed', () => {
    expect(
      holdsAnyTick(
        deriveVerificationState(
          {
            ...NONE,
            creatorVerifiedAt: new Date('2025-01-01T00:00:00.000Z'),
            creatorVerifiedUntil: new Date('2026-01-01T00:00:00.000Z'),
          },
          NOW,
        ),
      ),
    ).toBe(false);
  });
});

describe('oneYearFrom', () => {
  it('is a calendar year, so a leap day does not drift', () => {
    expect(oneYearFrom(new Date('2028-02-29T00:00:00.000Z')).toISOString()).toBe(
      '2029-03-01T00:00:00.000Z',
    );
    expect(oneYearFrom(new Date('2026-09-21T12:00:00.000Z')).toISOString()).toBe(
      '2027-09-21T12:00:00.000Z',
    );
  });
});
