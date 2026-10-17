import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { WalletReviewStage } from '../money-view.type';
import { CLAIM_LOST, EXPIRED_STATE } from './bvn-claim';
import {
  REVIEW_REASONS,
  type ReviewRecord,
  reviewReasonsOf,
  reviewStageOf,
} from './review-stage';

/**
 * The identity check, as publishing reads it (S7 round 2, F3; lead ruling
 * 17 Oct 2026: the pause is the Hub's, not the app's alone).
 *
 * Identity is checked when a person opens a wallet, never at sign-up (R-6),
 * and the check is the provider's own review of the person (Nuvion). A
 * person whose review is stuck cannot publish: the review is waiting for
 * documents, it was refused, it was stopped for good, or the application was
 * closed because it was left unfinished. That is "paused", and it has one
 * error code, `identity_paused`, with the Hub's own sentence.
 *
 * Everything else is not paused, and publishing is exactly as it was:
 * - `passed`: the wallet is open;
 * - `checking`: the review is under way (being checked, or approved with the
 *   account number on its way);
 * - never started: no review was ever sent (the person has not opened a
 *   wallet), or the server runs a provider that does not review the person
 *   itself (Fintava), so there is nothing to read.
 *
 * The stage is the one `GET /money/wallet` tells (`review.stage`): the same
 * rows, the same rule (`reviewStageOf`), so the wallet and the gate can never
 * disagree. Reads our database only; never asks the provider.
 */

/** The stages at which the check is paused. */
export type IdentityPauseStage = Extract<
  WalletReviewStage,
  'needs_documents' | 'rejected' | 'stopped' | 'expired'
>;

/** What a paused check is: its stage and the Hub's sentence for it. */
export interface IdentityPause {
  stage: IdentityPauseStage;
  /** The Hub's own sentence. No em-dash. */
  message: string;
}

/** The one error code of this refusal. */
export const IDENTITY_PAUSED_CODE = 'identity_paused';

/** The opening row, as far as the pause reads it. */
export interface PauseOpening {
  state: string;
  failure: string | null;
}

/** NuvionEntity's columns the pause is read from. */
export const PAUSE_ENTITY_SELECT = {
  entityId: true,
  status: true,
  decidedAt: true,
  correctedAt: true,
  bvnStatus: true,
  ninStatus: true,
  documentStatus: true,
  addressProofStatus: true,
  rejectionReasons: true,
} as const;

export type PauseEntity = ReviewRecord & { entityId: string | null };

/** The lead of every sentence: what is paused, and until when. */
const LEAD = 'Publishing is paused until your identity check passes.';

/** What a review waiting for documents says (the review has no reasons yet). */
const NEEDS_DOCUMENTS = {
  message: 'Your wallet is not finished opening.',
  fix: 'Send the documents the bank asked for.',
};

/**
 * The stage at which the person's review stands, or null when it was never
 * sent. The same reading as `ReviewedOpening.reviewOf`: an opening marked
 * expired shadows the provider's word, and an opening stopped because its BVN
 * is now another account's reads as a stop whatever the provider says.
 */
function stageOf(
  opening: PauseOpening | null,
  entity: PauseEntity | null,
): WalletReviewStage | null {
  if (!entity?.entityId) return null;
  if (opening?.state === EXPIRED_STATE) return 'expired';
  if (opening?.state === 'stopped' && opening.failure === CLAIM_LOST) {
    return 'stopped';
  }
  return reviewStageOf(entity);
}

/** The sentence for a paused stage: the lead, what went wrong, what to do. */
function sentenceOf(stage: IdentityPauseStage, entity: PauseEntity): string {
  let said: { message: string; fix: string };
  if (stage === 'needs_documents') said = NEEDS_DOCUMENTS;
  else if (stage === 'expired') said = REVIEW_REASONS.review_expired;
  else if (stage === 'stopped') said = REVIEW_REASONS.review_stopped;
  else said = reviewReasonsOf(entity)[0] ?? REVIEW_REASONS.details_not_verified;
  return [LEAD, said.message, said.fix].filter((s) => s.length > 0).join(' ');
}

/**
 * Whether the check is paused, from the rows. Pure. `reviews` is whether the
 * running provider reviews the person itself (`capabilities.separateKyc`);
 * `hasWallet` is whether the person has a wallet row (the check passed).
 */
export function identityPauseOf(input: {
  reviews: boolean;
  hasWallet: boolean;
  opening: PauseOpening | null;
  entity: PauseEntity | null;
}): IdentityPause | null {
  if (!input.reviews || input.hasWallet) return null;
  const stage = stageOf(input.opening, input.entity);
  if (
    stage !== 'needs_documents' &&
    stage !== 'rejected' &&
    stage !== 'stopped' &&
    stage !== 'expired'
  ) {
    return null;
  }
  return {
    stage,
    message: sentenceOf(stage, input.entity as PauseEntity),
  };
}

/**
 * The refusal. 403 in the contract's one error shape (docs/contract/
 * CONVENTIONS.md section 3): `{ statusCode, message, data: null, reason }`,
 * with `reason.code` `identity_paused`. The app switches on the code and
 * shows `message`; there are no offers to carry.
 */
export class IdentityPausedError extends HttpException {
  readonly pause: IdentityPause;

  constructor(pause: IdentityPause) {
    super(
      {
        message: pause.message,
        reason: {
          code: IDENTITY_PAUSED_CODE,
          message: pause.message,
          stage: pause.stage,
        },
      },
      HttpStatus.FORBIDDEN,
    );
    this.pause = pause;
  }
}

/**
 * Reads whether a person's identity check is paused. Under a provider that
 * does not review the person itself nothing is ever paused and nothing is
 * read. Our database only: three single-row reads, the last two only for a
 * person with no wallet.
 */
@Injectable()
export class IdentityPauseService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  async of(wawuUserId: string): Promise<IdentityPause | null> {
    if (!this.provider.capabilities.separateKyc) return null;
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (wallet) return null;
    const [opening, entity] = await Promise.all([
      this.prisma.fintavaWalletOpening.findUnique({
        where: { wawuUserId },
        select: { state: true, failure: true },
      }),
      this.prisma.nuvionEntity.findUnique({
        where: { wawuUserId },
        select: PAUSE_ENTITY_SELECT,
      }),
    ]);
    return identityPauseOf({
      reviews: true,
      hasWallet: false,
      opening,
      entity,
    });
  }
}
