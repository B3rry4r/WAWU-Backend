import type { CommunityMessageModel } from '../../../generated/prisma/models';
import type { VerificationState } from '../verification/verification-state';

/** The sender's public identity, batch-looked-up alongside a page of messages. */
export interface CommunityMessageSender {
  wawuId: string;
  /** Real display name from WAWU ID, falling back to the handle, then ''. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  /** Both ticks, derived server-side. Never a rung, never a rank. */
  verification: VerificationState;
}

/**
 * Prisma model plus one ADDITIVE, optional field. This used to be a bare
 * `export type CommunityMessage = CommunityMessageModel` — every row carried
 * only `senderWawuId`, with no name/handle/avatar for the client to render
 * (list() never joined UserProfile or called WawuIdClient). `sender` is
 * populated by CommunityMessageService.list() from a batched lookup, same
 * pattern as DirectMessage's `otherParty`; `create()`'s return still omits
 * it (optional, so a bare Prisma row still satisfies the type) since the
 * sender there is always the caller, who already knows who they are.
 */
export type CommunityMessage = CommunityMessageModel & {
  sender?: CommunityMessageSender;
};
