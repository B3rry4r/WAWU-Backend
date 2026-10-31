import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { LivePublisher } from '../live/live-publisher.service';
import { kindOf } from './message-kind';

/** The refusal a muted member gets when they send. The app keys on `reason.code`, never on the words. */
export const MUTED_IN_ROOM_CODE = 'muted_in_room';
export const MUTED_IN_ROOM_MESSAGE = 'The host has muted you in this room.';

/** What the host's moderation sheet reads: who is muted, and whether the caller is. */
export interface RoomModerationView {
  /** True when the host has muted the caller in this room. */
  muted: boolean;
  /** The members the host has muted. Only the host is told; everyone else gets an empty list. */
  mutedMembers: string[];
}

const ONLY_THE_HOST = 'Only the host of this room can do that.';

/**
 * MOD-ROOMS (R-122). What the host of a room can do in their own room: delete any message in it, and mute a member (they
 * still read; sending is refused) and unmute them. Removing a member is NOT here: it exists already (INBOX-25, R-71) and
 * carries the refund of an unused pass.
 *
 * A mute or an unmute reaches that member's open room at once (`community.mute.changed` on the live channel, M3), and a
 * phone that was away reads it from the catch-up; a repeat of either changes nothing and sends nothing.
 *
 * Muting never touches money: nothing here reads or writes a pass, a credit, a refund or a wallet. Every act is written
 * to `CommunityModerationLog` (who, what, when) in the same transaction as the act, so there is never an act without its
 * record or a record without its act.
 */
@Injectable()
export class CommunityRoomModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LivePublisher,
  ) {}

  private async hostedBy(
    communityId: string,
    actorWawuId: string,
  ): Promise<{ id: string; hostWawuId: string }> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { id: true, hostWawuId: true },
    });
    if (!community) throw new NotFoundException('Community not found');
    if (community.hostWawuId !== actorWawuId) {
      throw new ForbiddenException(ONLY_THE_HOST);
    }
    return community;
  }

  /** True while the host's mute of this person in this room is in force. */
  async isMuted(communityId: string, userWawuId: string): Promise<boolean> {
    const row = await this.prisma.communityMute.findUnique({
      where: { communityId_userWawuId: { communityId, userWawuId } },
      select: { id: true },
    });
    return row !== null;
  }

  /** GET /communities/:id/moderation. Only a member or the host has a state here; anyone else is refused as in the room. */
  async view(
    communityId: string,
    callerWawuId: string,
  ): Promise<RoomModerationView> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { id: true, hostWawuId: true },
    });
    if (!community) throw new NotFoundException('Community not found');
    if (community.hostWawuId === callerWawuId) {
      const rows = await this.prisma.communityMute.findMany({
        where: { communityId },
        select: { userWawuId: true },
        orderBy: { mutedAt: 'asc' },
      });
      return { muted: false, mutedMembers: rows.map((r) => r.userWawuId) };
    }
    const member = await this.prisma.communityMembership.findUnique({
      where: {
        userWawuId_communityId: { userWawuId: callerWawuId, communityId },
      },
      select: { status: true },
    });
    if (!member || member.status !== 'joined') {
      throw new ForbiddenException('Join this community to see this.');
    }
    return {
      muted: await this.isMuted(communityId, callerWawuId),
      mutedMembers: [],
    };
  }

  /**
   * DELETE /communities/:id/messages/:messageId. The message is gone for everyone (the row is deleted, so no list, preview,
   * unread count or live catch-up can show it again), every member's open room is told at once (`community.message.removed`
   * on the live channel, and in the catch-up for a phone that was away), and the act is logged. A member or a stranger gets 403. The words are
   * not kept in the log, only the message's id and kind and who wrote it.
   */
  async deleteMessage(
    communityId: string,
    actorWawuId: string,
    messageId: string,
  ): Promise<{ removed: true }> {
    await this.hostedBy(communityId, actorWawuId);
    const message = await this.prisma.communityMessage.findFirst({
      where: { id: messageId, communityId },
      select: {
        id: true,
        senderWawuId: true,
        imageUrl: true,
        videoUrl: true,
        voiceUrl: true,
      },
    });
    if (!message) throw new NotFoundException('Message not found');
    const deleted = await this.prisma.$transaction(async (tx) => {
      const gone = await tx.communityMessage.deleteMany({
        where: { id: message.id, communityId },
      });
      // Two deletes at once: the second finds nothing and writes no second record.
      if (gone.count === 0) return false;
      await tx.communityModerationLog.create({
        data: {
          communityId,
          actorWawuId,
          action: 'message_deleted',
          targetWawuId: message.senderWawuId,
          messageId: message.id,
          messageKind: kindOf(message),
        },
      });
      return true;
    });
    // After the commit, through the channel new messages use: every member's open room drops it at once, and a phone that
    // was away reads it from the catch-up (the log row). Never throws; a lost signal is the catch-up's job.
    if (deleted) {
      await this.live.publish({
        kind: 'community.message.removed',
        communityId,
        messageId: message.id,
      });
    }
    return { removed: true };
  }

  /**
   * PUT /communities/:id/mutes/:userWawuId. Mutes a member of the room. The host cannot mute themselves, and a person who
   * is not a joined member of the room cannot be muted. Muting a member who is already muted is not an error and writes
   * no second record.
   */
  async mute(
    communityId: string,
    actorWawuId: string,
    targetWawuId: string,
  ): Promise<{ muted: true }> {
    const community = await this.hostedBy(communityId, actorWawuId);
    if (targetWawuId === community.hostWawuId) {
      throw new BadRequestException('You cannot mute yourself.');
    }
    const member = await this.prisma.communityMembership.findUnique({
      where: {
        userWawuId_communityId: { userWawuId: targetWawuId, communityId },
      },
      select: { status: true },
    });
    if (!member || member.status !== 'joined') {
      throw new NotFoundException('That person is not a member of this room.');
    }
    const changed = await this.prisma.$transaction(async (tx) => {
      const had = await tx.communityMute.findUnique({
        where: {
          communityId_userWawuId: { communityId, userWawuId: targetWawuId },
        },
        select: { id: true },
      });
      if (had) return false;
      await tx.communityMute.create({
        data: {
          communityId,
          userWawuId: targetWawuId,
          mutedByWawuId: actorWawuId,
        },
      });
      await tx.communityModerationLog.create({
        data: {
          communityId,
          actorWawuId,
          action: 'member_muted',
          targetWawuId,
        },
      });
      return true;
    });
    // After the commit (M3): the muted member's open room swaps the composer for the calm line at once. A repeat of a mute
    // changes nothing and tells nobody. Never throws; a lost signal is the catch-up's job.
    if (changed) {
      await this.live.publish({
        kind: 'community.mute.changed',
        communityId,
        userWawuId: targetWawuId,
        muted: true,
      });
    }
    return { muted: true };
  }

  /** DELETE /communities/:id/mutes/:userWawuId. Lifts the mute. A member who is not muted is not an error and writes no record. */
  async unmute(
    communityId: string,
    actorWawuId: string,
    targetWawuId: string,
  ): Promise<{ muted: false }> {
    await this.hostedBy(communityId, actorWawuId);
    const changed = await this.prisma.$transaction(async (tx) => {
      const gone = await tx.communityMute.deleteMany({
        where: { communityId, userWawuId: targetWawuId },
      });
      if (gone.count === 0) return false;
      await tx.communityModerationLog.create({
        data: {
          communityId,
          actorWawuId,
          action: 'member_unmuted',
          targetWawuId,
        },
      });
      return true;
    });
    // After the commit (M3): the composer comes back in the member's open room at once.
    if (changed) {
      await this.live.publish({
        kind: 'community.mute.changed',
        communityId,
        userWawuId: targetWawuId,
        muted: false,
      });
    }
    return { muted: false };
  }
}
