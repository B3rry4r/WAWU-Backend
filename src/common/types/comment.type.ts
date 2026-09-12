import type { CommentModel } from '../../../generated/prisma/models';

/**
 * A comment's author, resolved from `authorWawuId` — same batch-lookup shape
 * as `CommunityMessageSender` / `DmOtherParty`: WawuIdClient for the real
 * name, UserProfile for handle/avatar.
 */
export interface CommentAuthor {
  wawuId: string;
  /** Real display name from WAWU ID, falling back to the handle, then ''. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
}

/**
 * Prisma model plus the resolved author. Optional so `create()`'s bare-row
 * return (the author is always the caller themselves there — no lookup
 * needed) still typechecks; `list()` always attaches it.
 */
export type Comment = CommentModel & { author?: CommentAuthor };
