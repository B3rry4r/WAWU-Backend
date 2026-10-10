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

/**
 * The stage the provider's own word gives. `expired` is not one of them: it
 * is our marking of an opening left idle (the opening's state), which
 * shadows the provider's word in the view.
 */
export type EntityStage = Exclude<WalletReviewStage, 'expired'>;

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
export function reviewStageOf(r: ReviewRecord): EntityStage {
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
  stage: EntityStage,
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
export const NOT_PASSED = new Set([
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
  review_expired: {
    message: 'We closed your wallet application because it was not finished.',
    fix: 'Send your details again to start a new one.',
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
    canResubmitAt: null,
    decidedAt:
      stage === 'approved' || stage === 'rejected' || stage === 'stopped'
        ? (r.decidedAt?.toISOString() ?? null)
        : null,
  };
}

/**
 * The review of an opening marked expired (idle too long, or released by
 * support): its BVN was let go and the person starts again (round 3, N3).
 */
export function expiredViewOf(expiredAt: Date | null): WalletReviewView {
  return {
    stage: 'expired',
    reasons: [reason('review_expired')],
    canResubmit: true,
    canResubmitAt: null,
    decidedAt: expiredAt?.toISOString() ?? null,
  };
}

/**
 * A view whose tries are used up says so (round 3, N6): it never offers
 * `canResubmit` while the server would answer 429; `opensAt` is when the
 * tries open again.
 */
export function withTriesUsedUp(
  view: WalletReviewView,
  opensAt: Date | null,
): WalletReviewView {
  if (opensAt === null || !view.canResubmit) return view;
  return { ...view, canResubmit: false, canResubmitAt: opensAt.toISOString() };
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
  /** When the person last submitted for review (a correction, a resubmit). */
  submittedAt: Date | null;
  /** The check words as last recorded. */
  bvnStatus: string | null;
  ninStatus: string | null;
  documentStatus: string | null;
  addressProofStatus: string | null;
  identificationStatus: string | null;
}

/** What a re-read entity shows: its review word and each check's word. */
export interface DecisionRead {
  status: string;
  bvnStatus: string | null;
  ninStatus: string | null;
  documentStatus: string | null;
  addressProofStatus: string | null;
  identificationStatus: string | null;
}

/** A check word that is still waiting for a verdict. */
function waiting(word: string | null): boolean {
  const w = (word ?? '').trim().toLowerCase();
  return w === '' || w === 'pending' || w === 'incomplete';
}

/**
 * Whether any check came to a verdict that differs from the one recorded: a
 * word that is not "waiting" and not what was held. A check going back to
 * `pending` (a new document uploaded) is not a verdict.
 */
export function verdictMoved(held: DecisionHeld, read: DecisionRead): boolean {
  const pairs: Array<[string | null, string | null]> = [
    [held.bvnStatus, read.bvnStatus],
    [held.ninStatus, read.ninStatus],
    [held.documentStatus, read.documentStatus],
    [held.addressProofStatus, read.addressProofStatus],
    [held.identificationStatus, read.identificationStatus],
  ];
  return pairs.some(
    ([was, now]) =>
      !waiting(now) &&
      (now ?? '').trim().toLowerCase() !== (was ?? '').trim().toLowerCase(),
  );
}

/**
 * Whether a re-read entity shows a decision we have not recorded (NUV-02
 * round 3, N4). `read.status` must be a decision, and then:
 *
 * - none is held, or the word changed (it went through `pending`, or from
 *   one decision to another): new;
 * - the same word again with no submission by the person since the last
 *   decision (a replay, a delivery that only bumped Nuvion's `updated`):
 *   the same decision, nothing changes and nobody is told twice;
 * - the same word again after the person submitted (corrected details, a
 *   resubmit): new when Nuvion's check words moved to a verdict since they
 *   were recorded. With every word as it was, nothing says a review
 *   happened: the entity is only echoing the submission itself (Nuvion's
 *   `entities.updated` fires for our own PATCH), so it is not new.
 *
 * Nuvion's own `updated` time is not read: it moves for things that are not
 * decisions and may not move for one that is.
 */
export function isNewDecision(
  held: DecisionHeld | null,
  read: DecisionRead,
): boolean {
  if (!isDecision(read.status)) return false;
  if (held === null || held.decidedAt === null) return true;
  if (held.status.trim().toLowerCase() !== read.status.trim().toLowerCase()) {
    return true;
  }
  if (held.submittedAt === null || held.submittedAt <= held.decidedAt) {
    return false;
  }
  return verdictMoved(held, read);
}

/** What a decision tells the person (the notification), from our own words only. */
export type DecisionNotice =
  | { outcome: 'approved' }
  | { outcome: 'rejected'; fixes: string[] }
  | { outcome: 'stopped' }
  | { outcome: 'expired' };

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

/**
 * Whether the account number is on its way (WalletView.accountNumberStatus
 * `on_its_way`) for a person whose opening is reviewed by the provider: only
 * once the provider has approved them (NUV-04's rule, whose spec on main
 * holds an approved entity with nothing requested yet to read `on_its_way`).
 * A person who is being checked, has documents to send, was rejected, was
 * stopped (also for a BVN another account took) or whose opening expired is
 * not waiting for a number: `none` (NUV-02 round 3, merge with NUV-04).
 */
export function accountOnItsWay(stage: WalletReviewStage | null): boolean {
  return stage === 'approved';
}
