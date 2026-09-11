import type { BlockedAccountModel } from '../../../generated/prisma/models';

/** The blocked user's public identity, batch-looked-up alongside a page of rows. */
export interface BlockedAccountUser {
  wawuId: string;
  /** Real display name from WAWU ID, falling back to the handle, then ''. */
  name: string;
  handle: string | null;
  avatarUrl: string | null;
}

/**
 * Prisma model plus one ADDITIVE, optional field. This used to be a bare
 * `export type BlockedAccount = BlockedAccountModel` — every row carried
 * only `blockedWawuId`, with no name/handle/avatar for the client to render
 * (list() never joined UserProfile or called WawuIdClient). `blockedUser`
 * is populated by BlockedAccountService.list() from a batched lookup, same
 * pattern as DirectMessage's `otherParty`; `create()`/`remove()` still
 * return/operate on bare rows (optional field, so they need no change).
 */
export type BlockedAccount = BlockedAccountModel & {
  blockedUser?: BlockedAccountUser;
};
