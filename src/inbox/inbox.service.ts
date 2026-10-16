import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { DirectMessageService } from '../direct-message/direct-message.service';
import {
  decodeInboxCursor,
  encodeInboxCursor,
  type InboxCursor,
} from './inbox-cursor';
import { feedCtes, utc } from './inbox-feed.sql';
import type {
  InboxCommunity,
  InboxItem,
  InboxKind,
  InboxPage,
  InboxPerson,
  InboxPreview,
  InboxUnread,
} from './inbox-view.type';

const DEFAULT_PAGE_SIZE = 20;

interface FeedRow {
  kind: InboxKind;
  key: string;
  at: Date;
  unread: bigint;
}

interface ChatLastRow {
  chat_id: string;
  sender: string;
  kind: string;
  text: string | null;
  at: Date;
}

interface CommunityLastRow {
  community_id: string;
  sender: string;
  text: string | null;
  image_url: string | null;
  at: Date;
}

interface RoomRow {
  name: string;
  imageUrl: string | null;
  kind: 'open' | 'private';
  hostWawuId: string;
}

interface PaidStatRow {
  other: string;
  questions: bigint;
  waiting: bigint;
  next_deadline: Date | null;
}

interface PaidBubbleRow {
  other: string;
  text: string;
  is_reply: boolean;
}

/** Rows ranked at the epoch carry no activity: a host's room with no message. */
const NO_ACTIVITY = 0;

/** `paid_dm:<side>:<wawuId>` taken apart. */
function paidParts(key: string): { side: 'fan' | 'creator'; other: string } {
  const [, side, other] = key.split(':');
  return { side: side as 'fan' | 'creator', other };
}

const idOf = (key: string): string => key.slice(key.indexOf(':') + 1);

/**
 * The inbox: chats, paid questions and communities in one list with unread
 * counts (task INBOX-07). New routes only; every source route keeps answering
 * exactly as before.
 *
 *   GET /inbox          one cursor-paged list, latest activity first
 *   GET /inbox/unread   the Inbox tab's badge, and what it is made of
 *
 * The list is a pure function of what is stored: nothing is copied into a
 * feed table, so there is nothing to fall out of step. That is also what lets
 * live updates (INBOX-02) use it: a `chat.message`, `chat.read` or room
 * message event for a person means "their list and badge changed", and the
 * app refetches `GET /inbox` and `GET /inbox/unread`, or patches the row whose
 * `id` the event names.
 *
 * Ranking and counting are one SQL statement (inbox-feed.sql.ts). Hydrating a
 * page then costs a fixed number of queries whatever the page size: one per
 * source for the rows, one for each source's last bubble, one name lookup.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dms: DirectMessageService,
    private readonly blocks: BlockedAccountService,
  ) {}

  /** GET /inbox. */
  async list(
    me: string,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
    kind?: InboxKind,
  ): Promise<InboxPage> {
    const after = decodeInboxCursor(cursor);
    const rows = await this.rank(me, after, limit + 1, kind);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.hydrate(me, page),
      nextCursor:
        rows.length > limit && last
          ? encodeInboxCursor(last.at, last.key)
          : null,
    };
  }

  /** GET /inbox/unread. */
  async unread(me: string): Promise<InboxUnread> {
    const rows = await this.prisma.$queryRaw<
      { kind: InboxKind; unread: bigint }[]
    >(Prisma.sql`
      WITH ${feedCtes(me, new Date())}
      SELECT kind, COALESCE(sum(unread), 0)::bigint AS unread FROM feed GROUP BY kind`);
    const by = (kind: InboxKind): number =>
      Number(rows.find((r) => r.kind === kind)?.unread ?? 0);
    const chats = by('chat');
    const paidDms = by('paid_dm');
    const communities = by('community');
    return {
      total: chats + paidDms + communities,
      chats,
      paidDms,
      communities,
    };
  }

  // ── ranking ──────────────────────────────────────────────────────────────

  private async rank(
    me: string,
    after: InboxCursor | null,
    take: number,
    kind: InboxKind | undefined,
  ): Promise<FeedRow[]> {
    const tail = after
      ? Prisma.sql`(f.at < ${utc(after.at)}
           OR (f.at = ${utc(after.at)} AND f.key COLLATE "C" < ${after.key}::text COLLATE "C"))`
      : Prisma.sql`true`;
    return this.prisma.$queryRaw<FeedRow[]>(Prisma.sql`
      WITH ${feedCtes(me, new Date())}
      SELECT f.kind, f.key, f.at, f.unread FROM feed f
      WHERE ${kind ? Prisma.sql`f.kind = ${kind}` : Prisma.sql`true`} AND ${tail}
      ORDER BY f.at DESC, f.key COLLATE "C" DESC
      LIMIT ${take}`);
  }

  // ── a page of rows ───────────────────────────────────────────────────────

  private async hydrate(me: string, page: FeedRow[]): Promise<InboxItem[]> {
    if (page.length === 0) return [];
    const of = (kind: InboxKind) => page.filter((r) => r.kind === kind);
    const chatRows = of('chat');
    const roomRows = of('community');
    const paidRows = of('paid_dm');

    const [chats, rooms, paid, hidden] = await Promise.all([
      this.chatParts(me, chatRows),
      this.roomParts(me, roomRows),
      this.paidParts(me, paidRows),
      this.blocks.hiddenFrom(me),
    ]);

    const people = await this.dms.lookupOtherParties([
      ...chats.others.values(),
      ...[...rooms.last.values()].map((l) => l.sender),
      ...paid.others,
    ]);
    const person = (id: string): InboxPerson =>
      people.get(id) ?? {
        wawuId: id,
        name: '',
        handle: null,
        avatarUrl: null,
        verification: deriveVerificationState(null),
      };
    const hiddenSet = new Set(hidden);

    // A chat or room deleted between the ranking and this read has nothing
    // left to draw, so its row is left out.
    const items = page.map((r): InboxItem | null => {
      const base = {
        id: r.key,
        kind: r.kind,
        lastActivityAt:
          r.at.getTime() === NO_ACTIVITY ? null : r.at.toISOString(),
        unreadCount: Number(r.unread),
        chat: null,
        paidDm: null,
        community: null,
      };
      if (r.kind === 'chat') {
        const id = idOf(r.key);
        const other = chats.others.get(id);
        if (other === undefined) return null;
        const last = chats.last.get(id);
        return {
          ...base,
          preview: last
            ? {
                text: last.text,
                attachment:
                  last.kind === 'image' ||
                  last.kind === 'video' ||
                  last.kind === 'file'
                    ? last.kind
                    : null,
                mine: last.sender === me,
                senderName: null,
                sentAt: last.at.toISOString(),
              }
            : null,
          chat: {
            chatId: id,
            other: person(other),
            canMessage: !hiddenSet.has(other),
          },
        };
      }
      if (r.kind === 'community') {
        const id = idOf(r.key);
        const last = rooms.last.get(id);
        const room = rooms.rooms.get(id);
        if (!room) return null;
        const community: InboxCommunity = {
          communityId: id,
          name: room.name,
          imageUrl: room.imageUrl,
          kind: room.kind,
          role: room.hostWawuId === me ? 'host' : 'member',
        };
        return {
          ...base,
          preview: last
            ? {
                text: last.text,
                attachment: last.image_url ? 'image' : null,
                mine: last.sender === me,
                senderName: person(last.sender).name,
                sentAt: last.at.toISOString(),
              }
            : null,
          community,
        };
      }
      const { side, other } = paidParts(r.key);
      const stat = paid.stats.get(r.key);
      const bubble = paid.bubbles.get(r.key);
      const preview: InboxPreview | null = bubble
        ? {
            text: bubble.text,
            attachment: null,
            // The fan wrote a question, the creator wrote a reply.
            mine: side === 'fan' ? !bubble.is_reply : bubble.is_reply,
            senderName: null,
            sentAt: r.at.toISOString(),
          }
        : null;
      return {
        ...base,
        preview,
        paidDm: {
          side,
          other: person(other),
          questionCount: Number(stat?.questions ?? 0),
          waitingCount: Number(stat?.waiting ?? 0),
          nextDeadlineAt: stat?.next_deadline
            ? stat.next_deadline.toISOString()
            : null,
        },
      };
    });
    return items.filter((i): i is InboxItem => i !== null);
  }

  /** The other person and the last message of each chat on the page. */
  private async chatParts(
    me: string,
    rows: FeedRow[],
  ): Promise<{
    others: Map<string, string>;
    last: Map<string, ChatLastRow>;
  }> {
    const others = new Map<string, string>();
    const last = new Map<string, ChatLastRow>();
    if (rows.length === 0) return { others, last };
    const ids = rows.map((r) => idOf(r.key));
    const [chats, lasts] = await Promise.all([
      this.prisma.chatConversation.findMany({
        where: { id: { in: ids } },
        select: { id: true, userAWawuId: true, userBWawuId: true },
      }),
      this.prisma.$queryRaw<ChatLastRow[]>(Prisma.sql`
        SELECT DISTINCT ON (m."conversationId")
               m."conversationId" AS chat_id, m."senderWawuId" AS sender,
               m."kind" AS kind, m."text" AS text, m."createdAt" AS at
        FROM "ChatMessage" m
        WHERE m."conversationId" IN (${Prisma.join(ids)})
        ORDER BY m."conversationId", m."createdAt" DESC, m."id" DESC`),
    ]);
    for (const c of chats) {
      others.set(c.id, c.userAWawuId === me ? c.userBWawuId : c.userAWawuId);
    }
    for (const l of lasts) last.set(l.chat_id, l);
    return { others, last };
  }

  /** Each room's name and cover and last message. */
  private async roomParts(
    me: string,
    rows: FeedRow[],
  ): Promise<{
    rooms: Map<string, RoomRow>;
    last: Map<string, CommunityLastRow>;
  }> {
    const rooms = new Map<string, RoomRow>();
    const last = new Map<string, CommunityLastRow>();
    if (rows.length === 0) return { rooms, last };
    const ids = rows.map((r) => idOf(r.key));
    const [communities, lasts] = await Promise.all([
      this.prisma.community.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          imageUrl: true,
          kind: true,
          hostWawuId: true,
        },
      }),
      // The preview leaves out what people either side blocked wrote, as
      // GET /communities/mine does.
      this.prisma.$queryRaw<CommunityLastRow[]>(Prisma.sql`
        SELECT DISTINCT ON (m."communityId")
               m."communityId" AS community_id, m."senderWawuId" AS sender,
               m."text" AS text, m."imageUrl" AS image_url, m."sentAt" AS at
        FROM "CommunityMessage" m
        WHERE m."communityId" IN (${Prisma.join(ids)})
          AND m."senderWawuId" NOT IN (
            SELECT "blockedWawuId" FROM "BlockedAccount" WHERE "userWawuId" = ${me}
            UNION
            SELECT "userWawuId" FROM "BlockedAccount" WHERE "blockedWawuId" = ${me})
        ORDER BY m."communityId", m."sentAt" DESC, m."id" DESC`),
    ]);
    for (const c of communities) rooms.set(c.id, c);
    for (const l of lasts) last.set(l.community_id, l);
    return { rooms, last };
  }

  /** Counts, soonest deadline and the last bubble of each paid thread on the page. */
  private async paidParts(
    me: string,
    rows: FeedRow[],
  ): Promise<{
    others: string[];
    stats: Map<string, PaidStatRow>;
    bubbles: Map<string, PaidBubbleRow>;
  }> {
    const stats = new Map<string, PaidStatRow>();
    const bubbles = new Map<string, PaidBubbleRow>();
    const others: string[] = [];
    const now = new Date();
    for (const side of ['fan', 'creator'] as const) {
      const wanted = rows
        .map((r) => paidParts(r.key))
        .filter((p) => p.side === side)
        .map((p) => p.other);
      if (wanted.length === 0) continue;
      others.push(...wanted);
      const meCol = Prisma.raw(
        side === 'fan' ? '"senderWawuId"' : '"creatorWawuId"',
      );
      const otherCol = Prisma.raw(
        side === 'fan' ? '"creatorWawuId"' : '"senderWawuId"',
      );
      const waiting = Prisma.sql`d."status" = 'awaiting_response' AND d."deadlineAt" > ${utc(now)}`;
      const [statRows, bubbleRows] = await Promise.all([
        this.prisma.$queryRaw<PaidStatRow[]>(Prisma.sql`
          SELECT d.${otherCol} AS other,
                 count(*) AS questions,
                 count(*) FILTER (WHERE ${waiting}) AS waiting,
                 min(d."deadlineAt") FILTER (WHERE ${waiting}) AS next_deadline
          FROM "DirectMessage" d
          WHERE d.${meCol} = ${me} AND d.${otherCol} IN (${Prisma.join(wanted)})
          GROUP BY d.${otherCol}`),
        // A reply is always later than the question it answers; on a tie the
        // reply wins, as in GET /paid-dm/threads.
        this.prisma.$queryRaw<PaidBubbleRow[]>(Prisma.sql`
          SELECT DISTINCT ON (b.other) b.other, b.text, b.is_reply FROM (
            SELECT d.${otherCol} AS other, d."text" AS text, d."sentAt" AS at,
                   false AS is_reply, d."id" AS id
            FROM "DirectMessage" d
            WHERE d.${meCol} = ${me} AND d.${otherCol} IN (${Prisma.join(wanted)})
            UNION ALL
            SELECT d.${otherCol}, r."text", r."createdAt", true, r."id"
            FROM "DmReply" r JOIN "DirectMessage" d ON d."id" = r."messageId"
            WHERE d.${meCol} = ${me} AND d.${otherCol} IN (${Prisma.join(wanted)})
          ) b
          ORDER BY b.other, b.at DESC, b.is_reply DESC, b.id DESC`),
      ]);
      for (const s of statRows) stats.set(`paid_dm:${side}:${s.other}`, s);
      for (const b of bubbleRows) bubbles.set(`paid_dm:${side}:${b.other}`, b);
    }
    return { others, stats, bubbles };
  }
}
