import type { CommunityMembershipModel } from '../../../generated/prisma/models';

/** Prisma model IS the wire shape for CommunityMembership — thin re-export. */
export type CommunityMembership = CommunityMembershipModel;

/**
 * One row of the host's review queue — `GET /communities/:id/requests`.
 *
 * The membership row plus the requester's `UserProfile.handle`, because a
 * queue of bare `userWawuId` UUIDs is not reviewable: the host would be
 * approving or declining strangers identified by nothing. `handle` is
 * genuinely nullable on UserProfile (it is set on the profile screen, and a
 * requester may have no profile row at all), so it is `string | null` here
 * and clients must fall back — nothing is fabricated to fill it.
 */
export type CommunityJoinRequest = CommunityMembership & {
  handle: string | null;
  /** UserProfile.avatarUrl. Genuinely nullable: not every requester has one. */
  avatarUrl: string | null;
};
