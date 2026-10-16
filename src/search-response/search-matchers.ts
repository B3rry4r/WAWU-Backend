import { AccountType, ContentStatus } from '../../generated/prisma/enums';
import type {
  CommunityWhereInput,
  ContentPieceWhereInput,
  UserProfileWhereInput,
} from '../../generated/prisma/models';

/**
 * What a search text matches, in one place. GET /search reads these three
 * clauses to answer, and GET /search/popular reads the same three to ask
 * whether a text finds anything a signed-out visitor could see (EXPLORE-05
 * round 2), so the two cannot drift apart.
 *
 * `hidden` is the people the caller blocked or who blocked the caller
 * (SETTINGS-04); a signed-out caller has none.
 */

/** Live content whose title, description or category contains `q`. */
export function contentMatch(
  q: string,
  hidden: string[],
): ContentPieceWhereInput {
  return {
    status: ContentStatus.live,
    creatorWawuId: { notIn: hidden },
    OR: [
      { title: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
    ],
  };
}

/**
 * Creator accounts whose handle or bio contains `q`. A match still needs a
 * `CreatorState` row to be listed (see `buildCreatorProfiles`).
 */
export function creatorMatch(
  q: string,
  hidden: string[],
): UserProfileWhereInput {
  return {
    accountType: AccountType.creator,
    wawuUserId: { notIn: hidden },
    OR: [
      { handle: { contains: q, mode: 'insensitive' } },
      { bio: { contains: q, mode: 'insensitive' } },
    ],
  };
}

/** Communities whose name contains `q`, any kind. */
export function communityMatch(
  q: string,
  hidden: string[],
): CommunityWhereInput {
  return {
    name: { contains: q, mode: 'insensitive' },
    hostWawuId: { notIn: hidden },
  };
}
