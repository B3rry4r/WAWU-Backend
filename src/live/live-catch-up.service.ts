import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { CommunityMessageService } from '../community-message/community-message.service';
import {
  decodeLiveCursor,
  encodeLiveCursor,
  LIVE_KIND_RANK,
  type LiveKind,
} from './live-cursor';
import { LIVE_LIMITS } from './live-limits';
import type { LiveCatchUp, LiveEvent } from './live-event.type';

interface Item {
  kind: LiveKind;
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
    const since = parsed.position
      ? parsed.at
      : new Date(parsed.at.getTime() - LIVE_LIMITS.catchUpOverlapMs);
    /**
     * The rows of one list that come after the cursor. Pages list rows by
     * time, then by list (messages, reads, room messages), then by id, so a
     * continuing cursor (which holds the last row's time, list and id) is
     * exact: lists before it are read past that time, the list it names past
     * that row, and lists after it from that time on.
     */
    const after = (kind: LiveKind, time: 'createdAt' | 'readAt' | 'sentAt') => {
      const p = parsed.position;
      if (!p) return { [time]: { gte: since } };
      const rank = LIVE_KIND_RANK[kind] - LIVE_KIND_RANK[p.kind];
      if (rank < 0) return { [time]: { gt: parsed.at } };
      if (rank > 0) return { [time]: { gte: parsed.at } };
      return {
        OR: [
          { [time]: { gt: parsed.at } },
          { [time]: parsed.at, id: { gt: p.id } },
        ],
      };
    };

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

    // A read mark has no id of its own: its chat's id stands for it.
    const readsAfter = (() => {
      const p = parsed.position;
      if (!p) return { readAt: { gte: since } };
      const rank = LIVE_KIND_RANK.r - LIVE_KIND_RANK[p.kind];
      if (rank < 0) return { readAt: { gt: parsed.at } };
      if (rank > 0) return { readAt: { gte: parsed.at } };
      return {
        OR: [
          { readAt: { gt: parsed.at } },
          { readAt: parsed.at, conversationId: { gt: p.id } },
        ],
      };
    })();

    const take = limit + 1;
    const [messages, reads, posts] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { conversationId: { in: chatIds }, ...after('m', 'createdAt') },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
      }),
      this.prisma.chatParticipant.findMany({
        where: {
          conversationId: { in: chatIds },
          wawuUserId: { not: me },
          ...readsAfter,
        },
        orderBy: [{ readAt: 'asc' }, { conversationId: 'asc' }],
        take,
      }),
      this.prisma.communityMessage.findMany({
        where: {
          communityId: { in: communityIds },
          ...after('p', 'sentAt'),
          senderWawuId: { notIn: [...blockedIds] },
        },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
        take,
      }),
    ]);

    const items: Item[] = [
      ...messages.map((row) => ({
        kind: 'm' as const,
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
                kind: 'r' as const,
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
        kind: 'p' as const,
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
      // Each list already comes in time-then-id order, and the sort is stable,
      // so ties in time keep the page order the cursor relies on.
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

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
    const last = page[page.length - 1];
    return {
      events,
      cursor: encodeLiveCursor(last.at, { kind: last.kind, id: last.id }),
      hasMore: true,
    };
  }
}
