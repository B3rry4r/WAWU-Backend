import { PrismaService } from '../../common/prisma/prisma.service';
import { POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT } from '../search-history.config';

/**
 * EXPLORE-06 (R-57). A community is a popular name only with enough members,
 * so a spec that wants a room to be a name gives it that many `joined`
 * members. The rows go with the room (CommunityMembership cascades), so a
 * spec's own clean-up of its rooms removes them. `tag` keeps the person ids
 * apart from other rooms' and other suites'.
 */
export async function joinMembers(
  prisma: PrismaService,
  communityId: string,
  tag: string,
  count: number = POPULAR_COMMUNITY_MIN_MEMBERS_DEFAULT,
  status: 'joined' | 'pending' = 'joined',
): Promise<void> {
  await prisma.communityMembership.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      userWawuId: `${tag}-m${i}-${communityId}`,
      communityId,
      status,
      ...(status === 'joined' ? { joinedAt: new Date() } : {}),
    })),
  });
}
