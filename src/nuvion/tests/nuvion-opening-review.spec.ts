import {
  type HoldFacts,
  heldBvnHash,
  holdFactsOf,
  holdsBvn,
  isReleasedBvnHash,
  releasedBvnHash,
} from '../../money/opening/bvn-claim';
import { isStringifiedNull } from '../../money/opening/dto/open-wallet.dto';
import { idleSince } from '../../money/opening/identity-hold';
import {
  accountOnItsWay,
  type DecisionHeld,
  type DecisionRead,
  expiredViewOf,
  isNewDecision,
  noticeOf,
  numbersFailed,
  openingStateForStage,
  type ReviewRecord,
  reviewReasonsOf,
  reviewStageOf,
  reviewViewOf,
  verdictMoved,
  withTriesUsedUp,
} from '../../money/opening/review-stage';
import { addressPlaceOf } from '../../money/opening/opening-attempts';
import {
  maskReviewWords,
  nuvionPhoneE164,
  readNuvionEntity,
} from '../areas/opening';
import { maskNuvionText } from '../nuvion-error';

/**
 * NUV-02, pure parts: Nuvion's review words to a stage, the opening state
 * the wallet gate reads, and the plain-word reasons; and the entity reader
 * (api-reference__entities.md's "Get an entity" example), which keeps each
 * check's word and masks Nuvion's own words.
 */

const base: ReviewRecord = {
  status: 'incomplete',
  decidedAt: null,
  correctedAt: null,
  bvnStatus: null,
  ninStatus: null,
  documentStatus: null,
  addressProofStatus: null,
  rejectionReasons: [],
};

describe('NUV-02: the review stage', () => {
  it.each([
    ['incomplete', 'needs_documents', 'review'],
    ['pending', 'checking', 'open'],
    ['approved', 'approved', 'open'],
    ['rejected', 'rejected', 'review'],
    ['failed', 'stopped', 'stopped'],
    ['suspended', 'stopped', 'stopped'],
    ['APPROVED ', 'approved', 'open'],
    ['something_new', 'checking', 'open'],
  ])('%s is %s (opening %s)', (status, stage, opening) => {
    const s = reviewStageOf({ ...base, status });
    expect(s).toBe(stage);
    expect(openingStateForStage(s)).toBe(opening);
  });

  it('a refusal followed by corrected details needs the documents again; a correction older than the decision does not', () => {
    const decidedAt = new Date('2026-10-08T10:00:00Z');
    expect(
      reviewStageOf({
        ...base,
        status: 'rejected',
        decidedAt,
        correctedAt: new Date('2026-10-08T10:00:01Z'),
      }),
    ).toBe('needs_documents');
    expect(
      reviewStageOf({
        ...base,
        status: 'rejected',
        decidedAt,
        correctedAt: new Date('2026-10-08T09:59:59Z'),
      }),
    ).toBe('rejected');
  });

  it('reasons: each check named, the phone only from Nuvion\'s words, else "details"; none unless refused or stopped', () => {
    expect(
      reviewReasonsOf({ ...base, status: 'pending', bvnStatus: 'rejected' }),
    ).toEqual([]);
    const all = reviewReasonsOf({
      ...base,
      status: 'rejected',
      bvnStatus: 'rejected',
      ninStatus: 'failed',
      documentStatus: 'not-approved',
      addressProofStatus: 'declined',
      rejectionReasons: ['The mobile number does not match the BVN'],
    });
    expect(all.map((r) => r.code)).toEqual([
      'bvn_not_verified',
      'nin_not_verified',
      'id_document_not_verified',
      'proof_of_address_not_verified',
      'bvn_phone_mismatch',
    ]);
    expect(
      reviewReasonsOf({
        ...base,
        status: 'rejected',
        rejectionReasons: ['Phone number format invalid'],
      }).map((r) => r.code),
    ).toEqual(['details_not_verified']);
    expect(
      reviewReasonsOf({ ...base, status: 'suspended' }).map((r) => r.code),
    ).toEqual(['review_stopped']);
    for (const r of all) {
      expect(`${r.message} ${r.fix}`).not.toMatch(/—|Nuvion/);
    }
  });

  it('numbers are sent again only when the review named the BVN or the NIN', () => {
    expect(numbersFailed({ ...base, bvnStatus: 'rejected' })).toBe(true);
    expect(numbersFailed({ ...base, ninStatus: 'rejected' })).toBe(true);
    expect(numbersFailed({ ...base, documentStatus: 'rejected' })).toBe(false);
  });

  it('the view: resubmission only after a refusal, the decision time only for a decision', () => {
    const decidedAt = new Date('2026-10-08T10:00:00Z');
    expect(
      reviewViewOf({ ...base, status: 'rejected', decidedAt }),
    ).toMatchObject({
      stage: 'rejected',
      canResubmit: true,
      decidedAt: '2026-10-08T10:00:00.000Z',
    });
    expect(
      reviewViewOf({ ...base, status: 'pending', decidedAt }),
    ).toMatchObject({
      canResubmit: false,
      decidedAt: null,
    });
  });
});

describe('NUV-02: reading an entity', () => {
  const example = {
    entity: {
      id: '01HXYZ0001ABCDEFGHJKMNPQRS',
      type: 'individual',
      status: 'Rejected',
      person_id: '01HXYZ0002ABCDEFGHJKMNPQRS',
      created: 1786965590981,
      rejection_reason:
        'ID number AB12345678CD and BVN 23487898752 could not be verified',
    },
    person: {
      id: '01HXYZ0002ABCDEFGHJKMNPQRS',
      email: 'Peter@Example.com',
      phonenumber: '+2348105391403',
    },
    identification: {
      verification_status: 'rejected',
      document: { number: '***3881', verification_status: 'rejected' },
      proof_of_address: { verification_status: 'pending' },
      identity_numbers: [
        { type: 'BVN', value: '***8752', verification_status: 'approved' },
        { type: 'nin', value: '***4238', verification_status: 'rejected' },
      ],
    },
  };

  it("keeps ids, words and times; the phone and email only to match; Nuvion's words masked", () => {
    const r = readNuvionEntity(example)!;
    expect(r).toMatchObject({
      entityId: '01HXYZ0001ABCDEFGHJKMNPQRS',
      type: 'individual',
      personId: '01HXYZ0002ABCDEFGHJKMNPQRS',
      status: 'rejected',
      created: 1786965590981,
      phone: '+2348105391403',
      email: 'peter@example.com',
      bvnStatus: 'approved',
      ninStatus: 'rejected',
      documentStatus: 'rejected',
      addressProofStatus: 'pending',
      identificationStatus: 'rejected',
    });
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).not.toMatch(/12345678|23487898752/);
    expect(r.reasons[0]).toMatch(/could not be verified/);
  });

  it('the bare entity a webhook carries is read too; no id or no status is unreadable', () => {
    expect(readNuvionEntity(example.entity)?.entityId).toBe(
      '01HXYZ0001ABCDEFGHJKMNPQRS',
    );
    expect(readNuvionEntity({ entity: { status: 'approved' } })).toBeNull();
    expect(
      readNuvionEntity({ entity: { id: '01HXYZ0001ABCDEFGHJKMNPQRS' } }),
    ).toBeNull();
    expect(
      readNuvionEntity({ entity: { id: '../x', status: 'approved' } }),
    ).toBeNull();
  });

  it('phones in E.164; masking cuts any run with 4 digits or more to its last 4', () => {
    expect(nuvionPhoneE164('08105391403')).toBe('+2348105391403');
    expect(nuvionPhoneE164('+447700900123')).toBe('+447700900123');
    expect(nuvionPhoneE164('call me')).toBeNull();
    expect(maskReviewWords('licence ABC12345XY expired')).toBe(
      'licence ******45XY expired',
    );
    expect(maskReviewWords('no digits here')).toBe('no digits here');
  });
});

describe('NUV-02 round 2: Nuvion text with numbers in groups (D5)', () => {
  it.each([
    ['BVN 2221 0003 123 refused', 'BVN *******3123 refused'],
    ['NIN 3331-0003-123 refused', 'NIN *******3123 refused'],
    ['ID 4441.0003.12 refused', 'ID ******0312 refused'],
    ['phone +234 803 123 4567 refused', 'phone +*********4567 refused'],
    ['mixed 2221 0003-123 refused', 'mixed *******3123 refused'],
    ['two  spaces 2221  0003  123 refused', 'two  spaces *******3123 refused'],
    ['contiguous 22210003123 refused', 'contiguous *******3123 refused'],
  ])('%s', (text, masked) => {
    expect(maskNuvionText(text)).toBe(masked);
  });

  it('short numbers and words are left alone', () => {
    expect(maskNuvionText('step 2 of 3, 12 items, version 4.1')).toBe(
      'step 2 of 3, 12 items, version 4.1',
    );
    expect(maskNuvionText('between 10 and 20 digits')).toBe(
      'between 10 and 20 digits',
    );
  });

  it('the stored reason words carry no group of 5 or more digits either', () => {
    const out = maskReviewWords(
      'BVN 2221 0003 123 and NIN 3331-0003-123 and licence AB 1234 567',
    );
    expect(out).not.toMatch(/\d(?:[ .-]?\d){4,}/);
  });
});

describe('NUV-02 round 3: numbers in any form are masked, in a log and in what is stored (N5)', () => {
  const fw = (v: string) =>
    v.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
  const ai = (v: string) =>
    v.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const groups = (b: string, sep: string) =>
    `${b.slice(0, 4)}${sep}${b.slice(4, 7)}${sep}${b.slice(7)}`;
  const BVN = '22217390137';
  // The verifier's 24 forms of an 11-digit number (p-mask.js).
  const FORMS: Array<[string, (b: string) => string]> = [
    ['plain', (b) => b],
    ['space', (b) => groups(b, ' ')],
    ['dash', (b) => groups(b, '-')],
    ['dot', (b) => groups(b, '.')],
    ['two-spaces', (b) => groups(b, '  ')],
    ['en-dash', (b) => groups(b, '\u2013')],
    ['nbsp', (b) => groups(b, '\u00a0')],
    ['space-dash-space', (b) => groups(b, ' - ')],
    ['slash', (b) => groups(b, '/')],
    ['comma', (b) => groups(b, ',')],
    ['comma-space', (b) => groups(b, ', ')],
    ['underscore', (b) => groups(b, '_')],
    ['colon', (b) => groups(b, ':')],
    ['three-spaces', (b) => groups(b, '   ')],
    ['tab', (b) => groups(b, '\t')],
    ['newline', (b) => groups(b, '\n')],
    ['singles', (b) => b.split('').join(' ')],
    ['fullwidth', (b) => fw(b)],
    ['arabic-indic', (b) => ai(b)],
    ['zwsp', (b) => groups(b, '\u200b')],
    ['letter-sep', (b) => groups(b, 'x')],
    ['parens', (b) => `(${b.slice(0, 4)})(${b.slice(4, 7)})(${b.slice(7)})`],
    ['hash-prefixed', (b) => `#${b}`],
    ['ref-glued', (b) => `REF${b}Z`],
  ];

  it('there are 24 forms', () => expect(FORMS).toHaveLength(24));

  it.each(FORMS)('%s: only the last 4 digits are left', (_name, form) => {
    const text = `BVN ${form(BVN)} is not valid`;
    for (const out of [maskNuvionText(text), maskReviewWords(text)]) {
      // No run of the number is left but its last four digits.
      const folded = out.replace(/[\uff10-\uff19\u0660-\u0669]/g, (c) =>
        String(c.charCodeAt(0) & 0xf),
      );
      // What is left is the end of the number: its last 4 digits, or fewer
      // where a letter glued to it is counted into the last 4 characters.
      const left = folded.replace(/\D/g, '');
      expect(left.length).toBeGreaterThanOrEqual(3);
      expect(left.length).toBeLessThanOrEqual(4);
      expect('0137'.endsWith(left)).toBe(true);
    }
  });

  it('digits of other scripts are read as digits; separators of every kind join groups', () => {
    expect(
      maskNuvionText(
        'NIN \u0663\u0663\u0663\u0661 \u0660\u0660\u0660\u0663 \u0661\u0662\u0663',
      ),
    ).toBe('NIN *******3123');
    expect(maskNuvionText('phone (0803) 123-4567 refused')).toBe(
      'phone (*******4567 refused',
    );
  });

  it('a gap of any length between the groups does not hide a number', () => {
    for (const gap of [
      ' '.repeat(9),
      ' '.repeat(40),
      '-'.repeat(12),
      ' \n\t '.repeat(5),
    ]) {
      const text = `BVN ${groups(BVN, gap)} is not valid`;
      for (const out of [maskNuvionText(text), maskReviewWords(text)]) {
        expect(out.replace(/\D/g, '')).toBe('0137');
      }
    }
  });

  it('a short number, a date part or a list of words is left alone', () => {
    expect(maskNuvionText('step 2 of 3, 12 items, version 4.1')).toBe(
      'step 2 of 3, 12 items, version 4.1',
    );
    expect(maskNuvionText('order 123456 shipped')).toBe('order 123456 shipped');
  });
});

describe('NUV-02 round 2: who holds a BVN (the stored form)', () => {
  const user = '6f1f6f5e-0f6e-4f0c-9d4e-1a2b3c4d5e6f';
  const hash = 'a'.repeat(64);

  it('a released hash goes back to the hash it was made from, and is not a hash', () => {
    const released = releasedBvnHash(user, hash);
    expect(released).not.toBe(hash);
    expect(isReleasedBvnHash(released)).toBe(true);
    expect(isReleasedBvnHash(hash)).toBe(false);
    expect(heldBvnHash(user, released)).toBe(hash);
    expect(heldBvnHash(user, hash)).toBe(hash);
    expect(releasedBvnHash(user, released)).toBe(released);
  });

  it('two accounts release the same BVN into different values (the unique key never meets)', () => {
    expect(releasedBvnHash(user, hash)).not.toBe(
      releasedBvnHash('another-user', hash),
    );
    expect(heldBvnHash('another-user', releasedBvnHash(user, hash))).not.toBe(
      hash,
    );
  });
});

describe('NUV-02 round 3: does the opening still hold its BVN (N1, N2)', () => {
  const facts = (o: Partial<HoldFacts>): HoldFacts => ({
    state: 'review',
    hasEntity: true,
    stage: 'needs_documents',
    bvnRefused: false,
    hasAccount: false,
    ...o,
  });

  it.each([
    ['documents needed', { stage: 'needs_documents' }, true],
    ['being checked', { stage: 'checking', state: 'open' }, true],
    ['approved', { stage: 'approved', state: 'open' }, true],
    [
      'refused on the documents only (the entity keeps the BVN)',
      { stage: 'rejected' },
      true,
    ],
    [
      'refused with nothing named (the details)',
      { stage: 'rejected', bvnRefused: false },
      true,
    ],
    [
      'refused on the BVN itself',
      { stage: 'rejected', bvnRefused: true },
      false,
    ],
    [
      'refused on the BVN, but an account is recorded',
      { stage: 'rejected', bvnRefused: true, hasAccount: true },
      true,
    ],
    [
      'failed or suspended with no account',
      { stage: 'stopped', state: 'stopped' },
      false,
    ],
    [
      'failed or suspended with an account (support decides)',
      { stage: 'stopped', state: 'stopped', hasAccount: true },
      true,
    ],
    [
      'expired, whatever the entity says',
      { state: 'expired', stage: 'needs_documents' },
      false,
    ],
    [
      'a create in flight, nothing recorded yet',
      { state: 'opening', hasEntity: false },
      true,
    ],
    [
      'a create whose answer was lost',
      { state: 'unknown', hasEntity: false },
      true,
    ],
    [
      'the provider refused the create, nothing was made',
      { state: 'failed', hasEntity: false },
      false,
    ],
  ] as const)('%s: held %s', (_name, over, holds) => {
    expect(holdsBvn(facts(over as Partial<HoldFacts>))).toBe(holds);
  });
});

describe('NUV-02 round 3: is a decision read back a new one (N4)', () => {
  const t = (n: number) => new Date(1_700_000_000_000 + n * 1000);
  const words = {
    bvnStatus: 'pending',
    ninStatus: 'pending',
    documentStatus: 'pending',
    addressProofStatus: 'pending',
    identificationStatus: 'pending',
  };
  const held = (o: Partial<DecisionHeld> = {}): DecisionHeld => ({
    status: 'rejected',
    decidedAt: t(1),
    submittedAt: null,
    ...words,
    ...o,
  });
  const read = (o: Partial<DecisionRead> = {}): DecisionRead => ({
    status: 'rejected',
    ...words,
    ...o,
  });
  const verdict = { bvnStatus: 'rejected', ninStatus: 'approved' };

  it('only a decision can be new', () => {
    expect(isNewDecision(null, read({ status: 'pending' }))).toBe(false);
    expect(isNewDecision(null, read({ status: 'incomplete' }))).toBe(false);
  });

  it('the first decision, or a different word, is new', () => {
    expect(isNewDecision(null, read())).toBe(true);
    expect(isNewDecision(held({ decidedAt: null }), read())).toBe(true);
    expect(isNewDecision(held({ status: 'pending' }), read())).toBe(true);
    expect(isNewDecision(held(), read({ status: 'approved' }))).toBe(true);
  });

  it('the same word again with no submission since the last decision is the same decision, whatever Nuvion bumped', () => {
    // A replay, a delivery that only moved Nuvion's `updated`, checks that
    // came to other verdicts: no submission, no new decision.
    expect(isNewDecision(held(), read())).toBe(false);
    expect(isNewDecision(held(), read(verdict))).toBe(false);
    // A submission older than the decision does not count.
    expect(isNewDecision(held({ submittedAt: t(0) }), read(verdict))).toBe(
      false,
    );
    expect(isNewDecision(held({ submittedAt: t(1) }), read(verdict))).toBe(
      false,
    );
  });

  it('after a submission, the same word is new when a check came to a verdict, whether Nuvion moved its time, kept it, or gave none', () => {
    // `updated` is not an input at all: the same read is new in all three.
    expect(isNewDecision(held({ submittedAt: t(5) }), read(verdict))).toBe(
      true,
    );
    expect(
      isNewDecision(
        held({ submittedAt: t(5) }),
        read({ documentStatus: 'rejected' }),
      ),
    ).toBe(true);
  });

  it('after a submission, the echo of the submission itself (every word as recorded, or a check back at pending) is not new', () => {
    expect(isNewDecision(held({ submittedAt: t(5) }), read())).toBe(false);
    expect(
      isNewDecision(
        held({ submittedAt: t(5), documentStatus: 'rejected' }),
        read({ documentStatus: 'pending' }),
      ),
    ).toBe(false);
  });

  it('a new failing verdict word is a not-passed word that is not what was held (N13)', () => {
    const h = held({ bvnStatus: 'rejected' });
    expect(verdictMoved(h, read({ bvnStatus: 'rejected' }))).toBe(false);
    expect(verdictMoved(h, read({ bvnStatus: 'pending' }))).toBe(false);
    expect(verdictMoved(h, read({ bvnStatus: null }))).toBe(false);
    expect(verdictMoved(h, read({ ninStatus: 'Rejected ' }))).toBe(true);
    expect(verdictMoved(h, read({ identificationStatus: 'failed' }))).toBe(
      true,
    );
  });

  it.each([
    'approved',
    'Approved ',
    'pending',
    'incomplete',
    '',
    null,
    'verified',
    'denied',
  ])(
    'a check coming back %j is not a failing verdict, whatever it was held at (N13)',
    (word) => {
      for (const field of [
        'bvnStatus',
        'ninStatus',
        'documentStatus',
        'addressProofStatus',
        'identificationStatus',
      ] as const) {
        for (const was of ['pending', 'rejected', 'approved', null]) {
          expect(
            verdictMoved(held({ [field]: was }), read({ [field]: word })),
          ).toBe(false);
        }
      }
    },
  );

  it.each([
    'rejected',
    'REJECTED',
    ' failed ',
    'declined',
    'not-approved',
    'not_approved',
    'invalid',
    'unverified',
  ])('a check coming to the failing word %j is a verdict', (word) => {
    for (const field of [
      'bvnStatus',
      'ninStatus',
      'documentStatus',
      'addressProofStatus',
      'identificationStatus',
    ] as const) {
      expect(
        verdictMoved(held({ [field]: 'pending' }), read({ [field]: word })),
      ).toBe(true);
    }
  });

  it('after a submission, a check that came back approving with the entity still rejected is not a new decision, but a failing word beside it is (N13)', () => {
    const h = held({ submittedAt: t(5), documentStatus: 'rejected' });
    expect(isNewDecision(h, read({ documentStatus: 'approved' }))).toBe(false);
    expect(
      isNewDecision(h, read({ bvnStatus: 'approved', ninStatus: 'approved' })),
    ).toBe(false);
    expect(
      isNewDecision(
        h,
        read({ documentStatus: 'approved', addressProofStatus: 'rejected' }),
      ),
    ).toBe(true);
  });
});

describe('NUV-02 round 4: only the BVN itself refused lets the BVN go (N11)', () => {
  const entity = (o: Record<string, unknown> = {}) => ({
    ...base,
    entityId: '01HXYZ0001ABCDEFGHJKMNPQRS',
    accountId: null,
    accountRequestedAt: null,
    submittedAt: null,
    progressAt: null,
    holdExpiredAt: null,
    ...o,
  });
  const holds = (o: Record<string, unknown>) =>
    holdsBvn(
      holdFactsOf('review', entity({ status: 'rejected', ...o }), false),
    );

  it.each([
    'rejected',
    'REJECTED',
    ' rejected ',
    'failed',
    'declined',
    'not-approved',
    'not_approved',
    'invalid',
    'unverified',
  ])('the BVN word %j is a refusal of the BVN: not held', (word) => {
    expect(holds({ bvnStatus: word, ninStatus: 'approved' })).toBe(false);
    expect(holds({ bvnStatus: word, ninStatus: 'rejected' })).toBe(false);
  });

  it.each([
    'approved',
    'pending',
    'incomplete',
    null,
    'suspended',
    'denied',
    'mismatch',
    'refused',
    'error',
    'no_match',
  ])(
    'the BVN word %j is not a refusal of the BVN: held, whatever the NIN and the documents say',
    (word) => {
      for (const ninStatus of ['rejected', 'approved', 'pending']) {
        expect(
          holds({
            bvnStatus: word,
            ninStatus,
            documentStatus: 'rejected',
            addressProofStatus: 'rejected',
          }),
        ).toBe(true);
      }
    },
  );

  it('a BVN refusal does not let go once an account is recorded', () => {
    expect(
      holds({
        bvnStatus: 'rejected',
        ninStatus: 'rejected',
        accountId: 'acc_1',
      }),
    ).toBe(true);
  });

  it('a refusal that names only the NIN can run out like any hold; one that names the BVN holds nothing and never does', () => {
    const day = 24 * 60 * 60_000;
    const t = (days: number) => new Date(1_700_000_000_000 + days * day);
    const opening = { state: 'review', attemptStartedAt: t(0) };
    const ninOnly = entity({
      status: 'rejected',
      decidedAt: t(2),
      bvnStatus: 'approved',
      ninStatus: 'rejected',
    });
    expect(idleSince(opening, ninOnly, false)).toEqual(t(2));
    expect(
      idleSince(opening, { ...ninOnly, bvnStatus: 'rejected' }, false),
    ).toBeNull();
  });
});

describe('NUV-02 round 3: an opening left idle (N3)', () => {
  const day = 24 * 60 * 60_000;
  const t = (days: number) => new Date(1_700_000_000_000 + days * day);
  const entity = (o: Record<string, unknown> = {}) => ({
    ...base,
    entityId: '01HXYZ0001ABCDEFGHJKMNPQRS',
    accountId: null,
    accountRequestedAt: null,
    submittedAt: null,
    progressAt: null,
    holdExpiredAt: null,
    ...o,
  });
  const opening = (o: Record<string, unknown> = {}) => ({
    state: 'review',
    attemptStartedAt: t(0),
    ...o,
  });

  it('documents needed: idle since the latest thing the person did', () => {
    expect(idleSince(opening(), entity(), false)).toEqual(t(0));
    expect(idleSince(opening(), entity({ progressAt: t(3) }), false)).toEqual(
      t(3),
    );
    expect(idleSince(opening(), entity({ submittedAt: t(4) }), false)).toEqual(
      t(4),
    );
    expect(idleSince(opening(), entity({ correctedAt: t(5) }), false)).toEqual(
      t(5),
    );
  });

  it('refused on the documents or the details: idle since the person was told', () => {
    const rejected = entity({
      status: 'rejected',
      decidedAt: t(2),
      documentStatus: 'rejected',
    });
    expect(idleSince(opening(), rejected, false)).toEqual(t(2));
    expect(
      idleSince(opening(), { ...rejected, progressAt: t(6) }, false),
    ).toEqual(t(6));
  });

  it('never idle: refused on the identity (nothing is held), being checked, approved, stopped, an account, a wallet, no entity, not in review', () => {
    expect(
      idleSince(
        opening(),
        entity({ status: 'rejected', decidedAt: t(2), bvnStatus: 'rejected' }),
        false,
      ),
    ).toBeNull();
    for (const status of ['pending', 'approved', 'failed', 'suspended']) {
      expect(idleSince(opening(), entity({ status }), false)).toBeNull();
    }
    expect(
      idleSince(opening(), entity({ accountId: 'acc_1' }), false),
    ).toBeNull();
    expect(
      idleSince(opening(), entity({ accountRequestedAt: t(1) }), false),
    ).toBeNull();
    expect(idleSince(opening(), entity(), true)).toBeNull();
    expect(idleSince(opening(), entity({ entityId: null }), false)).toBeNull();
    expect(idleSince(opening(), null, false)).toBeNull();
    for (const state of ['open', 'opening', 'unknown', 'stopped', 'expired']) {
      expect(idleSince(opening({ state }), entity(), false)).toBeNull();
    }
  });

  it("the view of an expired opening: start again, never a reason that is Nuvion's", () => {
    const v = expiredViewOf(t(9));
    expect(v).toMatchObject({
      stage: 'expired',
      canResubmit: true,
      canResubmitAt: null,
      decidedAt: t(9).toISOString(),
    });
    expect(v.reasons.map((r) => r.code)).toEqual(['review_expired']);
    expect(`${v.reasons[0].message} ${v.reasons[0].fix}`).not.toMatch(
      /—|Nuvion/,
    );
  });
});

describe('NUV-02 round 3: the view never offers a try the server would refuse (N6)', () => {
  const rejected = reviewViewOf({
    ...base,
    status: 'rejected',
    decidedAt: new Date('2026-10-08T10:00:00Z'),
    bvnStatus: 'rejected',
  });

  it('tries left: the view is as it was', () => {
    expect(withTriesUsedUp(rejected, null)).toEqual(rejected);
    expect(rejected.canResubmit).toBe(true);
    expect(rejected.canResubmitAt).toBeNull();
  });

  it('tries used up: canResubmit is false and the time they open again is given', () => {
    const at = new Date('2026-10-09T10:00:00Z');
    expect(withTriesUsedUp(rejected, at)).toMatchObject({
      stage: 'rejected',
      canResubmit: false,
      canResubmitAt: at.toISOString(),
    });
    expect(withTriesUsedUp(expiredViewOf(null), at)).toMatchObject({
      stage: 'expired',
      canResubmit: false,
      canResubmitAt: at.toISOString(),
    });
  });

  it('a stage that offers no resubmission has no time either', () => {
    const waiting = reviewViewOf({ ...base, status: 'incomplete' });
    expect(withTriesUsedUp(waiting, new Date('2026-10-09T10:00:00Z'))).toEqual(
      waiting,
    );
  });
});

describe('NUV-02 round 3: the account number is on its way only after an approval (merge with NUV-04)', () => {
  it.each([
    ['being checked', 'checking', false],
    ['documents needed', 'needs_documents', false],
    ['refused', 'rejected', false],
    ['stopped (also for a BVN another account took)', 'stopped', false],
    ['expired', 'expired', false],
    ['approved', 'approved', true],
    ['nothing recorded', null, false],
  ] as const)('%s: %s', (_name, stage, onItsWay) => {
    expect(accountOnItsWay(stage)).toBe(onItsWay);
  });
});

describe('NUV-02 round 3: a word written out in place of nothing (N9)', () => {
  it.each([
    'null',
    'NULL',
    ' Null ',
    'undefined',
    'Undefined',
    '\tundefined\n',
  ])('%j is a stringified null', (v) =>
    expect(isStringifiedNull(v)).toBe(true),
  );
  it.each([
    '',
    'nullable',
    'undefined street',
    'Nulla',
    'nul',
    0,
    null,
    undefined,
  ])('%j is not', (v) => expect(isStringifiedNull(v)).toBe(false));
});

describe('NUV-02 round 2: what a decision tells the person (D6)', () => {
  it('approved, rejected with what to fix, stopped; nothing while it goes on', () => {
    expect(noticeOf({ ...base, status: 'approved' })).toEqual({
      outcome: 'approved',
    });
    expect(
      noticeOf({
        ...base,
        status: 'rejected',
        decidedAt: new Date(),
        bvnStatus: 'rejected',
        ninStatus: 'rejected',
      }),
    ).toEqual({
      outcome: 'rejected',
      fixes: [
        'Check the 11 digits of your BVN and send your details again.',
        'Check the 11 digits of your NIN and send your details again.',
      ],
    });
    expect(noticeOf({ ...base, status: 'suspended' })).toEqual({
      outcome: 'stopped',
    });
    expect(noticeOf({ ...base, status: 'pending' })).toBeNull();
    expect(noticeOf({ ...base, status: 'incomplete' })).toBeNull();
    // After corrected details the person is at "documents needed" again.
    expect(
      noticeOf({
        ...base,
        status: 'rejected',
        decidedAt: new Date(1000),
        correctedAt: new Date(2000),
      }),
    ).toBeNull();
  });

  it('the entity reader keeps Nuvion own update time', () => {
    const r = readNuvionEntity({
      entity: {
        id: '01HXYZ0001ABCDEFGHJKMNPQRS',
        status: 'rejected',
        updated: 1_786_966_136_585,
      },
    });
    expect(r?.updated).toBe(1_786_966_136_585);
    expect(
      readNuvionEntity({
        entity: { id: '01HXYZ0001ABCDEFGHJKMNPQRS', status: 'rejected' },
      })?.updated,
    ).toBeNull();
  });
});

describe('NUV-02 round 3: the place an address stands for (the per-address limit)', () => {
  it('an IPv4 address is itself; an IPv4-mapped IPv6 address is its IPv4 address', () => {
    expect(addressPlaceOf('203.0.113.9')).toBe('203.0.113.9');
    expect(addressPlaceOf(' ::ffff:203.0.113.9 ')).toBe('203.0.113.9');
  });

  it('an IPv6 address is its /64: every address of the block is one place', () => {
    const place = addressPlaceOf('2001:db8:1:2::1');
    expect(place).toBe('2001:0db8:0001:0002/64');
    expect(addressPlaceOf('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe(place);
    expect(addressPlaceOf('2001:db8:1:2:0:0:0:7')).toBe(place);
    expect(addressPlaceOf('2001:db8:1:2::')).toBe(place);
    expect(addressPlaceOf('fe80::1%eth0')).toBe('fe80:0000:0000:0000/64');
  });

  it('another block is another place; something that is no address is kept as it is', () => {
    expect(addressPlaceOf('2001:db8:1:3::1')).not.toBe(
      addressPlaceOf('2001:db8:1:2::1'),
    );
    expect(addressPlaceOf('::')).toBe('0000:0000:0000:0000/64');
    expect(addressPlaceOf('not-an-address')).toBe('not-an-address');
  });
});

describe('NUV-02 round 4: the mask covers any length of separators between digit groups, in any digit script (N14)', () => {
  const NUMBER = '27391845062';
  const to = (base: number) => (v: string) =>
    v.replace(/\d/g, (d) => String.fromCodePoint(base + Number(d)));
  const SCRIPTS: Array<[string, (v: string) => string]> = [
    ['ascii', (v) => v],
    ['fullwidth', to(0xff10)],
    ['arabic-indic', to(0x0660)],
    ['persian', to(0x06f0)],
    ['devanagari', to(0x0966)],
    ['bengali', to(0x09e6)],
    ['thai', to(0x0e50)],
    ['mathematical bold', to(0x1d7ce)],
    ['mathematical monospace', to(0x1d7f6)],
    ['tibetan', to(0x0f20)],
    ['n’ko', to(0x07c0)],
    [
      'circled',
      (v) =>
        v.replace(/\d/g, (d) =>
          d === '0' ? '\u24ea' : String.fromCodePoint(0x2460 + Number(d) - 1),
        ),
    ],
    [
      'mixed',
      (v) =>
        [...v]
          .map((c, i) =>
            i % 3 === 0
              ? to(0x0660)(c)
              : i % 3 === 1
                ? to(0xff10)(c)
                : to(0x0966)(c),
          )
          .join(''),
    ],
  ];
  const SEPARATORS: Array<[string, string]> = [
    ['space', ' '],
    ['tab', '\t'],
    ['newline', '\n'],
    ['no-break space', '\u00a0'],
    ['ideographic space', '\u3000'],
    ['zero-width space', '\u200b'],
    ['zero-width joiner', '\u200d'],
    ['dash', '-'],
    ['en dash', '\u2013'],
    ['dot', '.'],
    ['comma', ','],
    ['underscore', '_'],
    ['slash', '/'],
    ['plus', '+'],
    ['x', 'x'],
    ['X', 'X'],
    ['equals', '='],
    ['brackets', ')('],
    ['star', '*'],
    ['emoji', '\u{1F600}'],
  ];
  const GAPS = [1, 2, 9, 39, 40, 41, 60, 100, 300];
  const digitsLeft = (text: string): number =>
    text
      .normalize('NFKC')
      .replace(
        /[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\u09e6-\u09ef\u0e50-\u0e59\u0f20-\u0f29\u07c0-\u07c9]/gu,
        '0',
      )
      .replace(/[^0-9]/g, '').length;
  const SHAPES: Array<
    [string, (to: (v: string) => string, glue: string) => string]
  > = [
    [
      'grouped',
      (f, g) =>
        [NUMBER.slice(0, 4), NUMBER.slice(4, 7), NUMBER.slice(7)]
          .map(f)
          .join(g),
    ],
    ['single digits', (f, g) => [...NUMBER].map(f).join(g)],
    // A long run that is itself a blob, with spaces on both sides: the digit
    // groups either side must still be one number.
    [
      'spaced run',
      (f, g) => `${f(NUMBER.slice(0, 4))} ${g} ${f(NUMBER.slice(4))}`,
    ],
  ];

  for (const [scriptName, f] of SCRIPTS) {
    it(`${scriptName}: every separator, every shape, every gap keeps at most the last 4 digits (text and stored words)`, () => {
      const leaks: string[] = [];
      for (const [sepName, sep] of SEPARATORS) {
        for (const gap of GAPS) {
          const glue = sep.repeat(gap);
          for (const [shape, build] of SHAPES) {
            const text = `BVN ${build(f, glue)} is not valid`;
            for (const [fn, mask] of [
              ['maskNuvionText', (t: string) => maskNuvionText(t)],
              ['maskReviewWords', (t: string) => maskReviewWords(t)],
            ] as const) {
              const out = mask(text);
              if (digitsLeft(out) > 4) {
                leaks.push(
                  `${sepName} x ${gap} / ${shape} / ${fn}: ${out.slice(0, 60)}`,
                );
              }
            }
          }
        }
      }
      expect(leaks).toEqual([]);
    });
  }

  it('the last 4 are shown and nothing else of the number is (a long run of slashes with a space either side is one gap), and a run glued to the digits is masked whole as data', () => {
    const run = '/'.repeat(45);
    const spaced = maskNuvionText(`BVN 2739 ${run} 184 ${run} 5062 is wrong`);
    expect(spaced).toContain('5062');
    expect(digitsLeft(spaced)).toBe(4);
    expect(spaced).toContain('is wrong');
    const glued = maskNuvionText(`BVN 2739${run}184${run}5062 is wrong`);
    expect(digitsLeft(glued)).toBe(0);
    expect(glued).toContain('[data]');
  });

  it('a letter is not a separator: digits split by words are separate short numbers and stay as written', () => {
    for (const text of [
      'amounts 1234 and 5678 and 9012',
      'ddd 1234a5678a9012 z',
      '2739 then 1845 then 062',
    ]) {
      expect(maskNuvionText(text)).toBe(text);
    }
  });

  it('a blob or a credential written in full-width characters is masked like one in ASCII (the characters are folded before the blob and credential passes)', () => {
    const wide = (v: string) =>
      v.replace(/[A-Za-z0-9]/g, (c) =>
        String.fromCodePoint(c.codePointAt(0)! + 0xfee0),
      );
    const out = maskNuvionText(`file ${wide('Ab1'.repeat(20))} end`);
    expect(out).toBe('file [data] end');
    expect(maskNuvionText(`${wide('Bearer')} ${wide('abc.def')}`)).toBe(
      '[credential]',
    );
  });

  it('a credential or a blob between two digit groups is still one gap, and its own words stay', () => {
    const out = maskNuvionText(
      `ref 2739 ${'A'.repeat(60)} 1845062 and Bearer abc.def.ghi`,
    );
    expect(out).toContain('[credential]');
    expect(digitsLeft(out)).toBeLessThanOrEqual(4);
  });
});
