import { Injectable } from '@nestjs/common';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProfileDetailsService } from './profile-details.service';
import { UserProfileService } from './user-profile.service';
import type { VisitorProfileView } from './visitor-profile.type';

/**
 * ME-02: the visitor's view of a profile (M5, M6, M33), composed from the
 * routes the web already calls plus the three things they lack. The public
 * profile and the profile fields are read through their own services, so
 * every rule they apply (blocked either way, no creator state, a profile
 * view counted once per viewer per day) applies here unchanged, and a person
 * those routes hide is a 404 here too.
 */
@Injectable()
export class VisitorProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly profiles: UserProfileService,
    private readonly details: ProfileDetailsService,
  ) {}

  async get(
    idOrHandle: string,
    viewerWawuId: string,
  ): Promise<VisitorProfileView> {
    const profile = await this.profiles.getPublicProfile(
      idOrHandle,
      viewerWawuId,
    );
    const person = profile.wawuUserId;
    const [fields, identities, edge, listings] = await Promise.all([
      this.details.getPublic(person, viewerWawuId),
      this.wawuId.lookupPublicIdentities([person]),
      this.prisma.followRelationship.findFirst({
        where: { followerWawuId: viewerWawuId, followingWawuId: person },
        select: { followerWawuId: true },
      }),
      this.prisma.professionalProfile.findMany({
        where: { wawuUserId: person, status: 'approved', listed: true },
        orderBy: [{ reviewedAt: 'desc' }, { id: 'asc' }],
        select: { id: true, headline: true, category: true },
      }),
    ]);
    const identity = identities.get(person);
    const name = [identity?.firstName, identity?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    return {
      name: name || null,
      own: person === viewerWawuId,
      following: edge !== null,
      profile,
      fields,
      listings: listings.map((l) => ({
        id: l.id,
        headline: l.headline ?? '',
        category: l.category,
      })),
    };
  }
}
