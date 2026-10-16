import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { ChatService } from '../chat/chat.service';
import { CommunityMessageService } from '../community-message/community-message.service';
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
  ) {}

  /** Queues a signal behind the earlier ones for the same room. */
  handle(signal: LiveSignal): Promise<void> {
    if (this.connections.size === 0) return Promise.resolve();
    const room =
      signal.kind === 'community.message'
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
      case 'community.message':
        return this.communityMessage(signal.communityId, signal.messageId);
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
      message: { ...row, sender: senders.get(sender) },
    };
    for (const wawuId of allowed) this.connections.send(wawuId, event);
  }
}
