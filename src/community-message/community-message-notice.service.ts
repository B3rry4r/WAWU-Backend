import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  COMMUNITY_NOTICE_CHUNK,
  NotificationService,
  type CommunityMessageEntry,
} from '../notification/notification.service';
import { CommunityPassAccess } from '../community/pass/community-pass-access.service';
import { NOW_UTC } from '../push/push-clock';
import {
  COMMUNITY_NOTICE_LEASE_SECONDS,
  COMMUNITY_NOTICE_MAX_WINDOW_SECONDS,
  COMMUNITY_NOTICE_SETTLE_SECONDS,
  COMMUNITY_NOTICE_SWEEP_SECONDS,
} from './community-notice-config';

/** What one pass did. */
export interface CommunityNoticeReport {
  /** True when this pass held the claim and folded a window. */
  ran: boolean;
  messages: number;
  communities: number;
  created: number;
  updated: number;
}

interface WindowMessage {
  communityId: string;
  senderWawuId: string;
  sentAt: Date;
}

interface Recipient {
  userWawuId: string;
  /** When the person joined (null for the host, and for older rows). */
  joinedAt: Date | null;
}

const EMPTY: CommunityNoticeReport = {
  ran: false,
  messages: 0,
  communities: 0,
  created: 0,
  updated: 0,
};

/**
 * FIX-105 (R-81, owner, 24 Oct 2026: "New messages, grouped"). Tells a person
 * when a community they joined has new messages, as ONE notice per person and
 * room that is updated (its count and its time) until the person opens the
 * room. Never for their own messages; the Z3 "Community messages" switch turns
 * it off; it reaches the phone as a push like the other kinds (PUSH_RULE).
 *
 * HOW A BUSY ROOM STAYS CHEAP. The request that stores a message writes
 * NOTHING here: no notification, no queue row, no lookup of the room's members
 * (CommunityMessageService is unchanged). This sweep runs every few seconds on
 * a timer, in every Hub instance, and:
 *
 *  1. claims the sweep with a lease on one cursor row (so two instances never
 *     fold the same window);
 *  2. reads the messages sent since the cursor, up to a few seconds ago (the
 *     settle time, so a slow commit is never missed), in ONE query;
 *  3. for each room that has any, reads the members in pages of
 *     COMMUNITY_NOTICE_CHUNK, and for each page asks the database a fixed
 *     number of questions (read marks, blocks, passes, switches, open notices)
 *     and writes in ONE transaction of at most six statements, however many
 *     members the page holds;
 *  4. moves the cursor to the end of the window.
 *
 * So the writes for a window are about six statements per 500 members of each
 * room that had messages, not one write per member per message: a room posting
 * a hundred messages in a window costs what one message costs. A window folded
 * twice (an instance stopped halfway) changes nothing, because each notice
 * remembers the end of the last window it counted (`countedUpTo`).
 *
 * Who is told: the members of the room (joined; a member who left or was
 * removed has no joined row) and its host, but never the sender of a message
 * about their own message; not a member whose pass for a paid room has ended
 * (they cannot read it); and not across a block (either direction), the same
 * rule the room's own list follows. A message counts for a person only if it
 * was sent after they joined and after they last opened the room.
 */
@Injectable()
export class CommunityMessageNoticeService {
  private readonly logger = new Logger(CommunityMessageNoticeService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly passAccess: CommunityPassAccess,
  ) {}

  @Interval('community-notice-sweep', COMMUNITY_NOTICE_SWEEP_SECONDS * 1000)
  async tick(): Promise<void> {
    try {
      const report = await this.runOnce();
      if (report.created + report.updated > 0) {
        this.logger.log(
          `Community notices: ${report.messages} messages in ${report.communities} rooms, ${report.created} notices written, ${report.updated} updated.`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Community notice sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * One pass. Returns what it did. `settleSeconds` is only for tests that
   * cannot wait.
   */
  async runOnce(
    settleSeconds: number = COMMUNITY_NOTICE_SETTLE_SECONDS,
  ): Promise<CommunityNoticeReport> {
    if (this.running) return EMPTY;
    this.running = true;
    try {
      const window = await this.claim(settleSeconds);
      if (!window) return EMPTY;
      let failed = false;
      const report: CommunityNoticeReport = { ...EMPTY, ran: true };
      try {
        const messages = await this.prisma.communityMessage.findMany({
          where: { sentAt: { gt: window.from, lte: window.to } },
          select: { communityId: true, senderWawuId: true, sentAt: true },
          orderBy: { sentAt: 'asc' },
        });
        report.messages = messages.length;
        const byRoom = new Map<string, WindowMessage[]>();
        for (const m of messages) {
          const list = byRoom.get(m.communityId);
          if (list) list.push(m);
          else byRoom.set(m.communityId, [m]);
        }
        for (const [communityId, list] of byRoom) {
          try {
            const done = await this.foldRoom(communityId, list, window.to);
            report.communities += 1;
            report.created += done.created;
            report.updated += done.updated;
          } catch (error) {
            // The cursor stays where it was: the window is tried again next
            // pass, and the rooms already folded count nothing twice.
            failed = true;
            this.logger.error(
              `Could not write the notices of one room: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } catch (error) {
        failed = true;
        this.logger.error(
          'Community notice window failed',
          error instanceof Error ? error.stack : String(error),
        );
      }
      await this.release(failed ? null : window.to);
      return report;
    } finally {
      this.running = false;
    }
  }

  /**
   * Takes the claim and returns the window to fold, or null when another
   * instance holds it or nothing new has settled. The very first pass starts
   * from "now": messages sent before this build never become notices.
   */
  private async claim(
    settleSeconds: number,
  ): Promise<{ from: Date; to: Date } | null> {
    await this.prisma.$executeRaw`
      INSERT INTO "CommunityNoticeCursor" ("id", "countedUpTo")
      VALUES (1, ${NOW_UTC} - make_interval(secs => ${settleSeconds}))
      ON CONFLICT ("id") DO NOTHING`;
    const rows = await this.prisma.$queryRaw<Array<{ from: Date; to: Date }>>`
      UPDATE "CommunityNoticeCursor"
      SET "leaseUntil" = ${NOW_UTC} + make_interval(secs => ${COMMUNITY_NOTICE_LEASE_SECONDS})
      WHERE "id" = 1
        AND ("leaseUntil" IS NULL OR "leaseUntil" < ${NOW_UTC})
        AND "countedUpTo" < ${NOW_UTC} - make_interval(secs => ${settleSeconds})
      RETURNING "countedUpTo" AS "from",
        LEAST(
          ${NOW_UTC} - make_interval(secs => ${settleSeconds}),
          "countedUpTo" + make_interval(secs => ${COMMUNITY_NOTICE_MAX_WINDOW_SECONDS})
        ) AS "to"`;
    return rows[0] ?? null;
  }

  /** Lets go of the claim, and moves the cursor to `upTo` when the window was folded. */
  private async release(upTo: Date | null): Promise<void> {
    if (upTo) {
      await this.prisma.$executeRaw`
        UPDATE "CommunityNoticeCursor"
        SET "countedUpTo" = GREATEST("countedUpTo", ${upTo.toISOString()}::timestamp), "leaseUntil" = NULL
        WHERE "id" = 1`;
    } else {
      await this.prisma.$executeRaw`
        UPDATE "CommunityNoticeCursor" SET "leaseUntil" = NULL WHERE "id" = 1`;
    }
  }

  /** The recipients of one room, a page at a time: the host first, then the joined members by id. */
  private async *recipientPages(
    communityId: string,
    hostWawuId: string,
  ): AsyncGenerator<Recipient[]> {
    let after: string | null = null;
    let first = true;
    for (;;) {
      const rows: Array<{ userWawuId: string; joinedAt: Date | null }> =
        await this.prisma.communityMembership.findMany({
          where: {
            communityId,
            status: 'joined',
            ...(after ? { userWawuId: { gt: after } } : {}),
          },
          select: { userWawuId: true, joinedAt: true },
          orderBy: { userWawuId: 'asc' },
          take: COMMUNITY_NOTICE_CHUNK,
        });
      const page: Recipient[] = rows
        .filter((r) => r.userWawuId !== hostWawuId)
        .map((r) => ({ userWawuId: r.userWawuId, joinedAt: r.joinedAt }));
      if (first) page.unshift({ userWawuId: hostWawuId, joinedAt: null });
      first = false;
      if (page.length > 0) yield page;
      if (rows.length < COMMUNITY_NOTICE_CHUNK) return;
      after = rows[rows.length - 1].userWawuId;
    }
  }

  private async foldRoom(
    communityId: string,
    messages: WindowMessage[],
    upTo: Date,
  ): Promise<{ created: number; updated: number }> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { id: true, name: true, hostWawuId: true },
    });
    if (!community) return { created: 0, updated: 0 };

    const senders = [...new Set(messages.map((m) => m.senderWawuId))];
    let created = 0;
    let updated = 0;
    for await (const page of this.recipientPages(
      communityId,
      community.hostWawuId,
    )) {
      const ids = page.map((r) => r.userWawuId);
      const members = ids.filter((id) => id !== community.hostWawuId);
      const [lapsed, markers, blocks] = await Promise.all([
        this.passAccess.lapsedMembers(communityId, members),
        this.prisma.communityReadMarker.findMany({
          where: { communityId, userWawuId: { in: ids } },
          select: { userWawuId: true, lastReadAt: true },
        }),
        this.prisma.blockedAccount.findMany({
          where: {
            OR: [
              { userWawuId: { in: ids }, blockedWawuId: { in: senders } },
              { blockedWawuId: { in: ids }, userWawuId: { in: senders } },
            ],
          },
          select: { userWawuId: true, blockedWawuId: true },
        }),
      ]);
      const readAt = new Map(markers.map((m) => [m.userWawuId, m.lastReadAt]));
      const blockedPairs = new Set<string>();
      for (const b of blocks) {
        blockedPairs.add(`${b.userWawuId}|${b.blockedWawuId}`);
        blockedPairs.add(`${b.blockedWawuId}|${b.userWawuId}`);
      }

      const entries: CommunityMessageEntry[] = [];
      for (const r of page) {
        if (lapsed.has(r.userWawuId)) continue;
        const lastReadAt = readAt.get(r.userWawuId) ?? null;
        const since = laterOf(lastReadAt, r.joinedAt);
        let add = 0;
        let lastMessageAt: Date | null = null;
        for (const m of messages) {
          if (m.senderWawuId === r.userWawuId) continue;
          if (since && m.sentAt <= since) continue;
          if (blockedPairs.has(`${r.userWawuId}|${m.senderWawuId}`)) continue;
          add += 1;
          lastMessageAt = m.sentAt;
        }
        if (add > 0 && lastMessageAt) {
          entries.push({
            userWawuId: r.userWawuId,
            add,
            lastMessageAt,
            lastReadAt,
          });
        }
      }
      if (entries.length === 0) continue;
      const done = await this.notifications.emitCommunityMessages(
        { id: community.id, name: community.name },
        entries,
        upTo,
      );
      created += done.created;
      updated += done.updated;
    }
    return { created, updated };
  }
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
