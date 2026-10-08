import {
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
