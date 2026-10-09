import type {
  WalletReviewReasonView,
  WalletReviewStage,
  WalletReviewView,
} from '../money-view.type';

/**
 * Where a provider's own review of a person stands, read from what WAWU
 * stores of it (NuvionEntity, task NUV-02), and what that means for the
 * opening and for the person. Pure: the opening service, the webhook
 * handler that records Nuvion's decisions (src/nuvion/handlers/
 * opening.handler.ts) and the specs share it, so they can never disagree.
 *
 * Nuvion's review states (core-concepts__entities.md, "Entity statuses"):
 * `incomplete` (created, documents or submission missing), `pending`
 * (submitted, being reviewed), `approved`, `rejected` (reasons given; the
 * entity may be submitted again), `failed` and `suspended`.
 */

/** What the stage is read from: NuvionEntity's columns. */
export interface ReviewRecord {
  /** Nuvion's own word for the review (`NuvionEntity.status`). */
  status: string;
  decidedAt: Date | null;
  /** When corrected details were last sent after a refusal. */
  correctedAt: Date | null;
  bvnStatus: string | null;
  ninStatus: string | null;
  documentStatus: string | null;
  addressProofStatus: string | null;
  /** Nuvion's own words for a refusal, masked. */
  rejectionReasons: string[];
}

/**
 * The stage, from Nuvion's word. A refusal after which corrected details
 * were sent reads `needs_documents` again: the review starts over from the
 * documents (NUV-03). A word we do not know reads `checking`: the person
 * waits and nothing is sent, never "approved" or "rejected" on a guess.
 */
export function reviewStageOf(r: ReviewRecord): WalletReviewStage {
  switch (r.status.trim().toLowerCase()) {
    case 'incomplete':
      return 'needs_documents';
    case 'approved':
      return 'approved';
    case 'rejected':
      return r.correctedAt !== null &&
        (r.decidedAt === null || r.correctedAt > r.decidedAt)
        ? 'needs_documents'
        : 'rejected';
    case 'failed':
    case 'suspended':
      return 'stopped';
    default:
      return 'checking';
  }
}

/**
 * The FintavaWalletOpening state an opening with a provider's review takes
 * for each stage (the opening table is the one the wallet gate reads,
 * src/money/gate/wallet-gate.ts):
 * - `review` (not one of the gate's "on its way" states): the person still
 *   has a step to take, documents or corrections: `not_open`,
 *   `409 wallet_not_open`;
 * - `open` (the gate's "recorded but not yet visible"): being checked, or
 *   approved with the account number on its way: `opening`,
 *   `409 wallet_opening`;
 * - `stopped`: failed or suspended at Nuvion: `not_open`,
 *   `409 wallet_not_open`, the existing no-wallet answer.
 */
export function openingStateForStage(
  stage: WalletReviewStage,
): 'review' | 'open' | 'stopped' {
  switch (stage) {
    case 'needs_documents':
    case 'rejected':
      return 'review';
    case 'checking':
    case 'approved':
      return 'open';
    case 'stopped':
      return 'stopped';
  }
}

/** The opening states a review moves between (and the gate reads). */
export const REVIEW_OPENING_STATES = ['review', 'open', 'stopped'] as const;

/** The words Nuvion uses for a check that did not pass. */
const NOT_PASSED = new Set([
  'rejected',
  'failed',
  'declined',
  'not-approved',
  'not_approved',
  'invalid',
  'unverified',
]);

function notPassed(word: string | null): boolean {
  return word !== null && NOT_PASSED.has(word.trim().toLowerCase());
}

/**
 * True only when Nuvion's own words name the phone as not matching (R-42:
 * A14 is answered only when Nuvion's response says so; its docs return no
 * BVN phone and no match, SANDBOX-FINDINGS item 3).
 */
export function namesPhoneMismatch(words: readonly string[]): boolean {
  return words.some(
    (w) =>
      /\bphone|\bmobile|phonenumber/i.test(w) &&
      /mismatch|not match|does ?n[o']t match|did ?n[o']t match|differ|doesn.t match/i.test(
        w,
      ),
  );
}

/** Plain words for each reason, and what to fix (no provider text). */
export const REVIEW_REASONS: Record<
  WalletReviewReasonView['code'],
  { message: string; fix: string }
> = {
  bvn_not_verified: {
    message: 'We could not confirm your BVN.',
    fix: 'Check the 11 digits of your BVN and send your details again.',
  },
  nin_not_verified: {
    message: 'We could not confirm your NIN.',
    fix: 'Check the 11 digits of your NIN and send your details again.',
  },
  id_document_not_verified: {
    message: 'We could not verify your ID document.',
    fix: 'Upload a clear photo of an ID that has not expired, and check its number.',
  },
  proof_of_address_not_verified: {
    message: 'We could not verify your proof of address.',
    fix: 'Upload a utility bill or bank statement from the last 3 months that shows your name and address.',
  },
  bvn_phone_mismatch: {
    // A14's own sentence (KYC-01).
    message: "This isn't the number on your BVN.",
    fix: 'Use the phone number on your BVN.',
  },
  details_not_verified: {
    message: 'We could not verify your details.',
    fix: 'Check that your name, date of birth and address match your ID, then send them again.',
  },
  review_stopped: {
    message: 'We could not open your wallet.',
    fix: 'Contact support and we will help.',
  },
};

function reason(code: WalletReviewReasonView['code']): WalletReviewReasonView {
  return { code, ...REVIEW_REASONS[code] };
}

/**
 * Why the review said no, in plain words: each check Nuvion names as not
 * passed, the phone only when Nuvion's words say so, and a general reason
 * when it names nothing we can read. Never Nuvion's own text.
 */
export function reviewReasonsOf(r: ReviewRecord): WalletReviewReasonView[] {
  const stage = reviewStageOf(r);
  if (stage === 'stopped') return [reason('review_stopped')];
  if (stage !== 'rejected') return [];
  const out: WalletReviewReasonView[] = [];
  if (notPassed(r.bvnStatus)) out.push(reason('bvn_not_verified'));
  if (notPassed(r.ninStatus)) out.push(reason('nin_not_verified'));
  if (notPassed(r.documentStatus)) out.push(reason('id_document_not_verified'));
  if (notPassed(r.addressProofStatus)) {
    out.push(reason('proof_of_address_not_verified'));
  }
  if (namesPhoneMismatch(r.rejectionReasons)) {
    out.push(reason('bvn_phone_mismatch'));
  }
  if (out.length === 0) out.push(reason('details_not_verified'));
  return out;
}

/** True when the review named the BVN or the NIN as what failed. */
export function numbersFailed(r: ReviewRecord): boolean {
  return notPassed(r.bvnStatus) || notPassed(r.ninStatus);
}

/** The review as GET /money/wallet tells it. */
export function reviewViewOf(r: ReviewRecord): WalletReviewView {
  const stage = reviewStageOf(r);
  return {
    stage,
    reasons: reviewReasonsOf(r),
    canResubmit: stage === 'rejected',
    decidedAt:
      stage === 'approved' || stage === 'rejected' || stage === 'stopped'
        ? (r.decidedAt?.toISOString() ?? null)
        : null,
  };
}

/** Nuvion's words that end a review (the time is kept as `decidedAt`). */
export function isDecision(status: string): boolean {
  return ['approved', 'rejected', 'failed', 'suspended'].includes(
    status.trim().toLowerCase(),
  );
}

/** What is held of the last decision, to tell a new one from the same again. */
export interface DecisionHeld {
  status: string;
  decidedAt: Date | null;
  correctedAt: Date | null;
  /** Nuvion's own `updated` time as last recorded (its clock). */
  entityUpdatedAt: Date | null;
}

/**
 * Whether a re-read entity shows a decision we have not recorded (NUV-02
 * round 2, D3): `read.status` must be a decision, and either none is held,
 * or the word changed, or the same word came after the person's corrected
 * details and Nuvion's own update time has moved past the one recorded with
 * the correction (a decision read with no later time is the echo of the
 * correction itself, which leaves the word as it was). When Nuvion gives no
 * update time, a decision after a correction is taken as new. The same
 * decision read again with no correction between is not new: nothing
 * changes and nobody is told twice.
 */
export function isNewDecision(
  held: DecisionHeld | null,
  read: { status: string; updated: number | null },
): boolean {
  if (!isDecision(read.status)) return false;
  if (held === null || held.decidedAt === null) return true;
  if (held.status.trim().toLowerCase() !== read.status.trim().toLowerCase()) {
    return true;
  }
  if (held.correctedAt === null || held.correctedAt <= held.decidedAt) {
    return false;
  }
  if (read.updated === null || held.entityUpdatedAt === null) return true;
  return read.updated > held.entityUpdatedAt.getTime();
}

/** What a decision tells the person (the notification), from our own words only. */
export type DecisionNotice =
  | { outcome: 'approved' }
  | { outcome: 'rejected'; fixes: string[] }
  | { outcome: 'stopped' };

/** The notice for the stage a record is at; null while the review goes on. */
export function noticeOf(r: ReviewRecord): DecisionNotice | null {
  switch (reviewStageOf(r)) {
    case 'approved':
      return { outcome: 'approved' };
    case 'rejected':
      return {
        outcome: 'rejected',
        fixes: [...new Set(reviewReasonsOf(r).map((x) => x.fix))],
      };
    case 'stopped':
      return { outcome: 'stopped' };
    default:
      return null;
  }
}
