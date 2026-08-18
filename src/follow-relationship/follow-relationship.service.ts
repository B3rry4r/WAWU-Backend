import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * FollowRelationship resource — registry.json "FollowRelationship". Both
 * endpoints require an authenticated WAWU user (roles: ["any"]); no
 * creator-gate involved. `:wawuId` must reference an existing creator
 * account (route is `/creators/:wawuId/follow`).
 */
@Injectable()
export class FollowRelationshipService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertFollowableCreator(followerWawuId: string, followingWawuId: string): Promise<void> {
    if (followerWawuId === followingWawuId) {
      throw new BadRequestException('Cannot follow yourself');
    }

    const target = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: followingWawuId },
      select: { wawuUserId: true, accountType: true },
    });

    if (!target || target.accountType !== 'creator') {
      throw new NotFoundException('Creator not found');
    }
  }

  /**
   * Whether the caller already follows this creator. The web client had no
   * way to ask, so it fell back to local mock state and showed the wrong
   * follow button on any new device or after clearing storage.
   */
  async status(followerWawuId: string, followingWawuId: string): Promise<{ following: boolean }> {
    const existing = await this.prisma.followRelationship.findFirst({
      where: { followerWawuId, followingWawuId },
      select: { followerWawuId: true },
    });
    return { following: existing !== null };
  }

  async follow(followerWawuId: string, followingWawuId: string): Promise<{ following: true }> {
    await this.assertFollowableCreator(followerWawuId, followingWawuId);

    await this.prisma.followRelationship.upsert({
      where: {
        followerWawuId_followingWawuId: { followerWawuId, followingWawuId },
      },
      update: {},
      create: { followerWawuId, followingWawuId },
    });

    return { following: true };
  }

  async unfollow(followerWawuId: string, followingWawuId: string): Promise<{ following: false }> {
    await this.assertFollowableCreator(followerWawuId, followingWawuId);

    await this.prisma.followRelationship.deleteMany({
      where: { followerWawuId, followingWawuId },
    });

    return { following: false };
  }
}
