import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { ChatService } from '../chat/chat.service';
import { CommunityMessageService } from '../community-message/community-message.service';
import { CommunityPassAccess } from '../community/pass/community-pass-access.service';
import { encodeLiveCursor } from './live-cursor';
import { LiveConnections } from './live-connections.service';
import type { LiveEvent, LiveLegalThreadEvent } from './live-event.type';
import type { LiveSignal } from './live-signal.type';

/**
 * Turns a signal into the events each connected person is allowed to have.
 *
 * Who may receive what is decided here, from the database, for every event
 * and not once when a socket opens, so a block, a leave or a removal takes
 * effect on sockets that are already open:
 *
 *  - a chat message or read mark goes to the two people in that chat, and to
 *    nobody once either of them has blocked the other (the reader's own other
 *    phones still get their own read mark);
 *  - a community message goes to the host and to members whose status is
 *    `joined`, and not to anyone who has blocked its sender or been blocked
 *    by them (the sender's own other phones still get it).
 *
 *  - a message the host deleted (`community.message.removed`, MOD-ROOMS, R-122) goes to the same people, host and joined
 *    members whose pass has not ended, with no block filter: it names a message by id and carries no words, so telling
 *    someone who blocked its writer to drop it leaks nothing;
 *
 *  - a mute or an unmute by the host (`community.mute.changed`, MOD-ROOMS r2, R-122) goes to the muted member only, on
 *    every phone they have open, and only while they are still a joined member; it carries the room's id and whether they
 *    are muted, no name and no words;
 *
 *  - a consultant's message on a legal matter goes to the client who owns the
 *    matter, and to nobody else (`legal.thread`, LEGAL-02); it names the
 *    matter, never the words.
 *
 * Signals about one room are handled in order, so a person sees a room's
 * messages in the order they were stored.
 */
@Injectable()
export class LiveDispatcher {
  private readonly logger = new Logger(LiveDispatcher.name);
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: LiveConnections,
    private readonly blocks: BlockedAccountService,
    private readonly chats: ChatService,
    private readonly communityMessages: CommunityMessageService,
    private readonly passAccess: CommunityPassAccess,
  ) {}

  /** Queues a signal behind the earlier ones for the same room. */
  handle(signal: LiveSignal): Promise<void> {
    if (this.connections.size === 0) return Promise.resolve();
    const room =
      signal.kind === 'community.message' ||
      signal.kind === 'community.message.removed' ||
      signal.kind === 'community.mute.changed'
        ? signal.communityId
        : signal.kind === 'legal.thread'
          ? signal.legalRequestId
          : signal.chatId;
    const tail = this.tails.get(room) ?? Promise.resolve();
    const next = tail
      .then(() => this.dispatch(signal))
      .catch((e: unknown) =>
        this.logger.warn(`Could not dispatch ${signal.kind}: ${String(e)}`),
      )
      .finally(() => {
        if (this.tails.get(room) === next) this.tails.delete(room);
      });
    this.tails.set(room, next);
    return next;
  }

  private async dispatch(signal: LiveSignal): Promise<void> {
    switch (signal.kind) {
      case 'chat.message':
        return this.chatMessage(signal.chatId, signal.messageId);
      case 'chat.read':
        return this.chatRead(signal.chatId, signal.readerWawuId);
      case 'money_request.updated':
        return this.moneyRequestUpdated(signal.chatId, signal.requestId);
      case 'community.message':
        return this.communityMessage(signal.communityId, signal.messageId);
      case 'community.message.removed':
        return this.communityMessageRemoved(
          signal.communityId,
          signal.messageId,
        );
      case 'community.mute.changed':
        return this.communityMuteChanged(
          signal.communityId,
          signal.userWawuId,
          signal.muted,
        );
      case 'legal.thread':
        return this.legalThread(signal.legalRequestId, signal.messageId);
    }
  }

  private async chatMessage(chatId: string, messageId: string): Promise<void> {
    const [row, chat] = await Promise.all([
      this.prisma.chatMessage.findUnique({ where: { id: messageId } }),
      this.prisma.chatConversation.findUnique({ where: { id: chatId } }),
    ]);
    if (!row || !chat) return;
    const here = [chat.userAWawuId, chat.userBWawuId].filter((id) =>
      this.connections.has(id),
    );
    if (here.length === 0) return;
    if (
      await this.blocks.isBlockedEitherWay(chat.userAWawuId, chat.userBWawuId)
    )
      return;
    await Promise.all(
      here.map(async (wawuId) => {
        const [message] = await this.chats.viewMessages(wawuId, [row]);
        if (!message) return;
        const event: LiveEvent = {
          type: 'chat.message',
          cursor: encodeLiveCursor(row.createdAt),
          message,
        };
        this.connections.send(wawuId, event);
      }),
    );
  }

  /**
   * A request was paid, declined or cancelled: both people in the chat get
   * the bubble as they see it now, and nobody once either has blocked the
   * other (as for a message).
   */
  private async moneyRequestUpdated(
    chatId: string,
    requestId: string,
  ): Promise<void> {
    const [request, chat] = await Promise.all([
      this.prisma.moneyRequest.findUnique({ where: { id: requestId } }),
      this.prisma.chatConversation.findUnique({ where: { id: chatId } }),
    ]);
    if (!request || !chat || !request.messageId || !request.changedAt) return;
    const here = [chat.userAWawuId, chat.userBWawuId].filter((id) =>
      this.connections.has(id),
    );
    if (here.length === 0) return;
    if (
      await this.blocks.isBlockedEitherWay(chat.userAWawuId, chat.userBWawuId)
    )
      return;
    const row = await this.prisma.chatMessage.findUnique({
      where: { id: request.messageId },
    });
    if (!row) return;
    await Promise.all(
      here.map(async (wawuId) => {
        const [message] = await this.chats.viewMessages(wawuId, [row]);
        if (!message) return;
        const event: LiveEvent = {
          type: 'money_request.updated',
          cursor: encodeLiveCursor(request.changedAt as Date),
          chatId,
          message,
        };
        this.connections.send(wawuId, event);
      }),
    );
  }

  private async legalThread(
    legalRequestId: string,
    messageId: string,
  ): Promise<void> {
    const row = await this.prisma.legalChatMessage.findUnique({
      where: { id: messageId },
    });
    // The signal is only ever sent for a consultant's message, and a row that
    // is not one, or not on this matter, is not a reason to wake anyone.
    if (
      !row ||
      row.legalRequestId !== legalRequestId ||
      row.authorRole !== 'consultant'
    )
      return;
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: legalRequestId },
      select: { wawuUserId: true },
    });
    if (!request || !this.connections.has(request.wawuUserId)) return;
    const event: LiveLegalThreadEvent = {
      type: 'legal.thread',
      cursor: encodeLiveCursor(row.createdAt),
      legalRequestId,
    };
    this.connections.send(request.wawuUserId, event);
  }

  private async chatRead(chatId: string, readerWawuId: string): Promise<void> {
    const chat = await this.prisma.chatConversation.findUnique({
      where: { id: chatId },
    });
    if (!chat) return;
    const mark = await this.prisma.chatParticipant.findUnique({
      where: {
        conversationId_wawuUserId: {
          conversationId: chatId,
          wawuUserId: readerWawuId,
        },
      },
    });
    if (!mark) return;
    const other =
      chat.userAWawuId === readerWawuId ? chat.userBWawuId : chat.userAWawuId;
    const blocked = await this.blocks.isBlockedEitherWay(readerWawuId, other);
    const to = blocked ? [readerWawuId] : [readerWawuId, other];
    const cursor = encodeLiveCursor(mark.readAt ?? new Date());
    for (const wawuId of to) {
      const event: LiveEvent = {
        type: 'chat.read',
        cursor,
        chatId,
        readerWawuId,
        mine: wawuId === readerWawuId,
        lastReadAt: mark.lastReadAt?.toISOString() ?? null,
        lastReadMessageId: mark.lastReadMessageId,
      };
      this.connections.send(wawuId, event);
    }
  }

  /**
   * The host deleted a message (MOD-ROOMS, R-122): everyone connected who is in the room drops it. The row is gone, so the
   * cursor is the time the host did it, read from the log the delete wrote in the same transaction.
   */
  private async communityMessageRemoved(
    communityId: string,
    messageId: string,
  ): Promise<void> {
    const [log, community] = await Promise.all([
      this.prisma.communityModerationLog.findFirst({
        where: { communityId, messageId, action: 'message_deleted' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.community.findUnique({
        where: { id: communityId },
        select: { hostWawuId: true },
      }),
    ]);
    if (!log || !community) return;
    const connected = this.connections.userIds();
    const members = await this.prisma.communityMembership.findMany({
      where: {
        communityId,
        status: 'joined',
        userWawuId: { in: connected },
      },
      select: { userWawuId: true },
    });
    const allowed = new Set(members.map((m) => m.userWawuId));
    // INBOX-24 (R-63): a member whose pass has ended is not sent the room.
    for (const id of await this.passAccess.lapsedMembers(
      communityId,
      [...allowed].filter((id) => id !== community.hostWawuId),
    )) {
      allowed.delete(id);
    }
    if (connected.includes(community.hostWawuId)) {
      allowed.add(community.hostWawuId);
    }
    const event: LiveEvent = {
      type: 'community.message.removed',
      cursor: encodeLiveCursor(log.createdAt),
      communityId,
      messageId,
    };
    for (const wawuId of allowed) this.connections.send(wawuId, event);
  }

  /**
   * The host muted or unmuted a member (MOD-ROOMS r2, R-122): that member's open room swaps the composer for the calm line,
   * or brings it back, at once. The cursor is the time the host did it, read from the log the act wrote in the same
   * transaction (the catch-up carries the same row).
   */
  private async communityMuteChanged(
    communityId: string,
    userWawuId: string,
    muted: boolean,
  ): Promise<void> {
    if (!this.connections.has(userWawuId)) return;
    const [log, member] = await Promise.all([
      this.prisma.communityModerationLog.findFirst({
        where: {
          communityId,
          targetWawuId: userWawuId,
          action: muted ? 'member_muted' : 'member_unmuted',
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.communityMembership.findUnique({
        where: { userWawuId_communityId: { userWawuId, communityId } },
        select: { status: true },
      }),
    ]);
    if (!log || member?.status !== 'joined') return;
    const event: LiveEvent = {
      type: 'community.mute.changed',
      cursor: encodeLiveCursor(log.createdAt),
      communityId,
      muted,
    };
    this.connections.send(userWawuId, event);
  }

  private async communityMessage(
    communityId: string,
    messageId: string,
  ): Promise<void> {
    const [row, community] = await Promise.all([
      this.prisma.communityMessage.findUnique({ where: { id: messageId } }),
      this.prisma.community.findUnique({
        where: { id: communityId },
        select: { hostWawuId: true },
      }),
    ]);
    if (!row || !community) return;
    const connected = this.connections.userIds();
    const members = await this.prisma.communityMembership.findMany({
      where: {
        communityId,
        status: 'joined',
        userWawuId: { in: connected },
      },
      select: { userWawuId: true },
    });
    const allowed = new Set(members.map((m) => m.userWawuId));
    // INBOX-24 (R-63): a member whose pass has ended is not sent the room.
    for (const id of await this.passAccess.lapsedMembers(
      communityId,
      [...allowed].filter((id) => id !== community.hostWawuId),
    )) {
      allowed.delete(id);
    }
    if (connected.includes(community.hostWawuId)) {
      allowed.add(community.hostWawuId);
    }
    if (allowed.size === 0) return;

    const sender = row.senderWawuId;
    const refused = await this.prisma.blockedAccount.findMany({
      where: {
        OR: [
          { userWawuId: sender, blockedWawuId: { in: [...allowed] } },
          { userWawuId: { in: [...allowed] }, blockedWawuId: sender },
        ],
      },
      select: { userWawuId: true, blockedWawuId: true },
    });
    for (const b of refused) {
      allowed.delete(b.userWawuId === sender ? b.blockedWawuId : b.userWawuId);
    }
    if (allowed.size === 0) return;

    const senders = await this.communityMessages.lookupSenders([sender]);
    const event: LiveEvent = {
      type: 'community.message',
      cursor: encodeLiveCursor(row.sentAt),
      communityId,
      // Links signed fresh, as the list signs them (FIX-71).
      message: {
        ...(await this.communityMessages.withFreshMedia(row)),
        sender: senders.get(sender),
      },
    };
    for (const wawuId of allowed) this.connections.send(wawuId, event);
  }
}
