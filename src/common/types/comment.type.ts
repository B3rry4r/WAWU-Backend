import type { CommentModel } from '../../../generated/prisma/models';
import type { VerificationState } from '../verification/verification-state';

/**
 * A comment's author, resolved from `authorWawuId` — same batch-lookup shape
 * as `CommunityMessageSender` / `DmOtherParty`: WawuIdClient for the real
 * name, UserProfile for handle/avatar.
 */
export interface CommentAuthor {
  wawuId: string;
  /**
   * Both ticks. A comment thread is a place people decide who to trust, so
   * it is one of the places the tick most has to appear.
   */
  verification: VerificationState;
  /** Real display name from WAWU ID, falling back to the handle, then ''. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
}

/**
 * Prisma model plus the resolved author and the caller's own like state.
 * Both optional so `create()`'s bare-row return (the author is always the
 * caller themselves there, no lookup needed; a just-posted comment is never
 * self-liked) still typechecks; `list()` always attaches both.
 */
export type Comment = CommentModel & {
  author?: CommentAuthor;
  likedByMe?: boolean;
};
