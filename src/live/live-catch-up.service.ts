import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { CommunityMessageService } from '../community-message/community-message.service';
import { decodeLiveCursor, encodeLiveCursor } from './live-cursor';
import { LIVE_LIMITS } from './live-limits';
import type { LiveCatchUp, LiveEvent } from './live-event.type';

interface Item {
  at: Date;
  id: string;
  build: () => LiveEvent | Promise<LiveEvent>;
}

/**
 * What a person missed since a cursor (task INBOX-02): the new messages in
 * their chats and communities and the read marks that moved, oldest first.
 * The app calls it after the socket reconnects and when it returns to the
 * foreground; it is a catch-up, and the socket carries everything after it.
 *
 * To lose nothing, a client opens the socket first, then catches up, and
 * drops by id what it already holds (a message in both). Read marks are state,
 * not a log: one event per chat carries the latest mark.
 *
 * It follows the same rules as the socket: chats where either person has
 * blocked the other, and community messages from a person on either side of a
 * block, are left out.
 */
@Injectable()
export class LiveCatchUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatService,
    private readonly communityMessages: CommunityMessageService,
  ) {}

  async catchUp(
    me: string,
    cursor: string | undefined,
    limit: number = LIVE_LIMITS.catchUpDefaultLimit,
  ): Promise<LiveCatchUp> {
    const now = new Date();
    if (cursor === undefined) {
      return { events: [], cursor: encodeLiveCursor(now), hasMore: false };
    }
    const parsed = decodeLiveCursor(cursor);
    const since = parsed.exact
      ? parsed.at
      : new Date(parsed.at.getTime() - LIVE_LIMITS.catchUpOverlapMs);

    const [chatRows, memberships, hosted, blocked] = await Promise.all([
      this.prisma.chatConversation.findMany({
        where: { OR: [{ userAWawuId: me }, { userBWawuId: me }] },
        select: { id: true, userAWawuId: true, userBWawuId: true },
      }),
      this.prisma.communityMembership.findMany({
        where: { userWawuId: me, status: 'joined' },
        select: { communityId: true },
      }),
      this.prisma.community.findMany({
        where: { hostWawuId: me },
        select: { id: true },
      }),
      this.prisma.blockedAccount.findMany({
        where: { OR: [{ userWawuId: me }, { blockedWawuId: me }] },
        select: { userWawuId: true, blockedWawuId: true },
      }),
    ]);
    const blockedIds = new Set(
      blocked.map((b) =>
        b.userWawuId === me ? b.blockedWawuId : b.userWawuId,
      ),
    );
    const chatIds = chatRows
      .filter(
        (c) =>
          !blockedIds.has(c.userAWawuId === me ? c.userBWawuId : c.userAWawuId),
      )
      .map((c) => c.id);
    const communityIds = [
      ...new Set([
        ...memberships.map((m) => m.communityId),
        ...hosted.map((c) => c.id),
      ]),
    ];

    const take = limit + 1;
    const [messages, reads, posts] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { conversationId: { in: chatIds }, createdAt: { gte: since } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
      }),
      this.prisma.chatParticipant.findMany({
        where: {
          conversationId: { in: chatIds },
          wawuUserId: { not: me },
          readAt: { gte: since },
        },
        orderBy: [{ readAt: 'asc' }, { conversationId: 'asc' }],
        take,
      }),
      this.prisma.communityMessage.findMany({
        where: {
          communityId: { in: communityIds },
          sentAt: { gte: since },
          senderWawuId: { notIn: [...blockedIds] },
        },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
        take,
      }),
    ]);

    const items: Item[] = [
      ...messages.map((row) => ({
        at: row.createdAt,
        id: row.id,
        build: async (): Promise<LiveEvent> => {
          const [message] = await this.chats.viewMessages(me, [row]);
          return {
            type: 'chat.message',
            cursor: encodeLiveCursor(row.createdAt),
            message,
          };
        },
      })),
      ...reads.flatMap((mark) =>
        mark.readAt
          ? [
              {
                at: mark.readAt,
                id: mark.conversationId,
                build: (): LiveEvent => ({
                  type: 'chat.read',
                  cursor: encodeLiveCursor(mark.readAt as Date),
                  chatId: mark.conversationId,
                  readerWawuId: mark.wawuUserId,
                  mine: false,
                  lastReadAt: mark.lastReadAt?.toISOString() ?? null,
                  lastReadMessageId: mark.lastReadMessageId,
                }),
              },
            ]
          : [],
      ),
      ...posts.map((row) => ({
        at: row.sentAt,
        id: row.id,
        build: (): LiveEvent => ({
          type: 'community.message',
          cursor: encodeLiveCursor(row.sentAt),
          communityId: row.communityId,
          // `sender` is filled in below, once for the whole page.
          message: row,
        }),
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1));

    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const events = await Promise.all(page.map(async (i) => i.build()));

    const senderIds = events.flatMap((e) =>
      e.type === 'community.message' ? [e.message.senderWawuId] : [],
    );
    if (senderIds.length > 0) {
      const senders = await this.communityMessages.lookupSenders(senderIds);
      for (const e of events) {
        if (e.type === 'community.message') {
          e.message = {
            ...e.message,
            sender: senders.get(e.message.senderWawuId),
          };
        }
      }
    }

    if (!hasMore) {
      return { events, cursor: encodeLiveCursor(now), hasMore: false };
    }
    // The page ended inside a stretch of rows with the same time: carry on
    // from the next millisecond rather than ask for the same page again.
    const last = page[page.length - 1].at;
    const next =
      last.getTime() === since.getTime() && parsed.exact
        ? new Date(last.getTime() + 1)
        : last;
    return { events, cursor: encodeLiveCursor(next, true), hasMore: true };
  }
}
