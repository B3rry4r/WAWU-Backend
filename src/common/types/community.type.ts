import type { CommunityModel } from '../../../generated/prisma/models';

export type Community = CommunityModel;

/**
 * Wire response for GET /communities, /communities/:id. `memberCount` and
 * `messagesToday` (registry note: "derived") are computed via count() over
 * CommunityMembership / CommunityMessage at read time, never stored columns.
 */
export type CommunityResponse = Community & {
  memberCount: number;
  messagesToday: number;
};
