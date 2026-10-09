import {
  heldBvnHash,
  isReleasedBvnHash,
  releasedBvnHash,
  stageHoldsBvn,
} from '../../money/opening/bvn-claim';
import {
  type DecisionHeld,
  isNewDecision,
  noticeOf,
  numbersFailed,
  openingStateForStage,
  type ReviewRecord,
  reviewReasonsOf,
  reviewStageOf,
  reviewViewOf,
} from '../../money/opening/review-stage';
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

  it.each([
    ['needs_documents', true],
    ['checking', true],
    ['approved', true],
    ['rejected', false],
    ['stopped', false],
  ] as const)('%s holds it: %s', (stage, holds) => {
    expect(stageHoldsBvn(stage)).toBe(holds);
  });
});

describe('NUV-02 round 2: is a decision read back a new one (D3)', () => {
  const t = (n: number) => new Date(1_700_000_000_000 + n * 1000);
  const held = (o: Partial<DecisionHeld> = {}): DecisionHeld => ({
    status: 'rejected',
    decidedAt: t(1),
    correctedAt: null,
    entityUpdatedAt: t(1),
    ...o,
  });

  it('only a decision can be new', () => {
    expect(isNewDecision(null, { status: 'pending', updated: 5 })).toBe(false);
    expect(isNewDecision(null, { status: 'incomplete', updated: null })).toBe(
      false,
    );
  });

  it('the first decision, or a different word, is new', () => {
    expect(isNewDecision(null, { status: 'rejected', updated: null })).toBe(
      true,
    );
    expect(
      isNewDecision(held({ decidedAt: null }), {
        status: 'rejected',
        updated: null,
      }),
    ).toBe(true);
    expect(
      isNewDecision(held({ status: 'pending', decidedAt: t(1) }), {
        status: 'rejected',
        updated: t(1).getTime(),
      }),
    ).toBe(true);
    expect(
      isNewDecision(held(), { status: 'approved', updated: t(1).getTime() }),
    ).toBe(true);
  });

  it('the same word again, with no correction between, is the same decision', () => {
    expect(
      isNewDecision(held(), { status: 'rejected', updated: t(9).getTime() }),
    ).toBe(false);
    expect(
      isNewDecision(held({ correctedAt: t(0) }), {
        status: 'rejected',
        updated: t(9).getTime(),
      }),
    ).toBe(false);
  });

  it('the same word after a correction is new only when Nuvion moved its own time on', () => {
    const afterCorrection = held({ correctedAt: t(5), entityUpdatedAt: t(5) });
    // The echo of the correction: Nuvion's time is the one the correction got.
    expect(
      isNewDecision(afterCorrection, {
        status: 'rejected',
        updated: t(5).getTime(),
      }),
    ).toBe(false);
    // Reviewed again later.
    expect(
      isNewDecision(afterCorrection, {
        status: 'rejected',
        updated: t(6).getTime(),
      }),
    ).toBe(true);
    // Nuvion gives no time (before or now): a decision after a correction is new.
    expect(
      isNewDecision(afterCorrection, { status: 'rejected', updated: null }),
    ).toBe(true);
    expect(
      isNewDecision(held({ correctedAt: t(5), entityUpdatedAt: null }), {
        status: 'rejected',
        updated: t(5).getTime(),
      }),
    ).toBe(true);
  });
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
