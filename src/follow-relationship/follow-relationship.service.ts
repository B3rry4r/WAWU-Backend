import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';

/**
 * FollowRelationship resource — registry.json "FollowRelationship". Both
 * endpoints require an authenticated WAWU user (roles: ["any"]); no
 * creator-gate involved. `:wawuId` must reference an existing creator
 * account (route is `/creators/:wawuId/follow`).
 */
@Injectable()
export class FollowRelationshipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

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

  /**
   * Blocking gate: neither party can follow the other once either has
   * blocked. BlockedAccountService.create() already severs any existing edge
   * in both directions, so this stops it being re-made.
   *
   * `createMany({ skipDuplicates: true })` replaces the previous upsert
   * because it is equally race-safe (ON CONFLICT DO NOTHING) but its `count`
   * tells us whether the follow is NEW — which is the difference between
   * notifying the creator once and notifying them on every idempotent
   * re-tap of a Follow button.
   */
  async follow(followerWawuId: string, followingWawuId: string): Promise<{ following: true }> {
    await this.assertFollowableCreator(followerWawuId, followingWawuId);
    await this.blockedAccounts.assertNotBlocked(
      followerWawuId,
      followingWawuId,
      'You cannot follow this account.',
    );

    const { count } = await this.prisma.followRelationship.createMany({
      data: [{ followerWawuId, followingWawuId }],
      skipDuplicates: true,
    });

    if (count > 0) {
      await this.notifications.emit({
        kind: 'new_follower',
        userWawuId: followingWawuId,
        // ME-10: opens the follower's profile.
        about: {
          target: { kind: 'profile', id: followerWawuId },
          actorWawuId: followerWawuId,
        },
      });
    }

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
