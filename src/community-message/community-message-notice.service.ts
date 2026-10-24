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
  COMMUNITY_NOTICE_LEASE_RENEW_SECONDS,
  COMMUNITY_NOTICE_LEASE_SECONDS,
  COMMUNITY_NOTICE_MAX_WINDOW_SECONDS,
  COMMUNITY_NOTICE_RETRY_BASE_SECONDS,
  COMMUNITY_NOTICE_RETRY_MAX_AGE_SECONDS,
  COMMUNITY_NOTICE_RETRY_MAX_SECONDS,
  COMMUNITY_NOTICE_RETRY_ROOMS,
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
 * a hundred messages in a window costs what one message costs.
 *
 * EXACT COUNT, WHATEVER IS REPLAYED (round 2). Every notice remembers the end
 * of the last window it counted (`countedUpTo`), written in the same
 * transaction as its count, and a person's mark for a room is the largest
 * `countedUpTo` of ALL their notices for it, read ones too. A message counts
 * for a person only if it was sent after that mark (and after they joined and
 * after they last opened the room). So a window folded again, a window that
 * ends later than the first try, a pass that stopped after writing and before
 * it moved the cursor, a lease that lapsed: each message is still counted
 * once, because the second look finds the mark already past it.
 *
 * ONE ROOM NEVER HOLDS THE OTHERS. A room whose notices fail to write is put
 * on a retry list (`CommunityNoticeRetry`, with the start of what it still has
 * to fold) and the cursor moves on; the room is tried again after a growing
 * wait, from where it failed, and the marks make that safe. The cursor is held
 * back only when the window itself cannot be read or the retry list cannot be
 * written. The lease is renewed while a long pass works.
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
   * One pass. Returns what it did. `settleSeconds` and `maxWindowSeconds` are
   * only for tests that cannot wait (a window that ends right after the
   * messages a spec wrote, as a real one does).
   */
  async runOnce(
    settleSeconds: number = COMMUNITY_NOTICE_SETTLE_SECONDS,
    maxWindowSeconds: number = COMMUNITY_NOTICE_MAX_WINDOW_SECONDS,
  ): Promise<CommunityNoticeReport> {
    if (this.running) return EMPTY;
    this.running = true;
    try {
      const window = await this.claim(settleSeconds, maxWindowSeconds);
      if (!window) return EMPTY;
      let failed = false;
      const report: CommunityNoticeReport = { ...EMPTY, ran: true };
      let renewedAt = Date.now();
      const beat = async (): Promise<void> => {
        if (
          Date.now() - renewedAt <
          COMMUNITY_NOTICE_LEASE_RENEW_SECONDS * 1000
        )
          return;
        await this.renewLease();
        renewedAt = Date.now();
      };
      try {
        const waiting = new Set(
          (
            await this.prisma.communityNoticeRetry.findMany({
              select: { communityId: true },
              take: 1000,
            })
          ).map((r) => r.communityId),
        );
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
          // A room waiting for its retry is folded there, from where it failed.
          if (waiting.has(communityId)) continue;
          try {
            const done = await this.foldRoom(
              communityId,
              list,
              window.to,
              beat,
            );
            report.communities += 1;
            report.created += done.created;
            report.updated += done.updated;
          } catch (error) {
            // This room alone is put on the retry list; the cursor moves on.
            // If even that cannot be written, the window is held and tried
            // again whole (the marks keep that from counting twice).
            this.logger.error(
              `Could not write the notices of one room: ${error instanceof Error ? error.message : String(error)}`,
            );
            try {
              await this.prisma.communityNoticeRetry.upsert({
                where: { communityId },
                create: {
                  communityId,
                  fromAt: window.from,
                  retryAt: retryAt(1),
                },
                update: {},
              });
            } catch (listError) {
              failed = true;
              this.logger.error(
                `Could not list a failed room for a retry: ${listError instanceof Error ? listError.message : String(listError)}`,
              );
            }
          }
        }
        await this.retryWaitingRooms(window.to, report, beat);
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
   * Tries again the rooms that failed before and are due (a few per pass),
   * from where each one failed up to the end of this window. A room that
   * folds is taken off the list; one that fails again waits twice as long.
   */
  private async retryWaitingRooms(
    upTo: Date,
    report: CommunityNoticeReport,
    beat: () => Promise<void>,
  ): Promise<void> {
    const due = await this.prisma.communityNoticeRetry.findMany({
      where: { retryAt: { lte: new Date() } },
      orderBy: { retryAt: 'asc' },
      take: COMMUNITY_NOTICE_RETRY_ROOMS,
    });
    const oldest = new Date(
      upTo.getTime() - COMMUNITY_NOTICE_RETRY_MAX_AGE_SECONDS * 1000,
    );
    for (const row of due) {
      try {
        const from = row.fromAt > oldest ? row.fromAt : oldest;
        const messages = await this.prisma.communityMessage.findMany({
          where: {
            communityId: row.communityId,
            sentAt: { gt: from, lte: upTo },
          },
          select: { communityId: true, senderWawuId: true, sentAt: true },
          orderBy: { sentAt: 'asc' },
        });
        if (messages.length > 0) {
          const done = await this.foldRoom(
            row.communityId,
            messages,
            upTo,
            beat,
          );
          report.communities += 1;
          report.created += done.created;
          report.updated += done.updated;
        }
        await this.prisma.communityNoticeRetry.deleteMany({
          where: { communityId: row.communityId },
        });
      } catch (error) {
        this.logger.error(
          `Could not write the notices of a waiting room: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.prisma.communityNoticeRetry.updateMany({
          where: { communityId: row.communityId },
          data: {
            attempts: { increment: 1 },
            retryAt: retryAt(row.attempts + 1),
          },
        });
      }
    }
  }

  /**
   * Takes the claim and returns the window to fold, or null when another
   * instance holds it or nothing new has settled. The very first pass starts
   * from "now": messages sent before this build never become notices.
   */
  private async claim(
    settleSeconds: number,
    maxWindowSeconds: number,
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
          "countedUpTo" + make_interval(secs => ${maxWindowSeconds})
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

  /** Keeps the claim while a long pass is still working, so no other instance takes the same window. */
  private async renewLease(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "CommunityNoticeCursor"
      SET "leaseUntil" = ${NOW_UTC} + make_interval(secs => ${COMMUNITY_NOTICE_LEASE_SECONDS})
      WHERE "id" = 1`;
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
    beat: () => Promise<void>,
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
      await beat();
      const ids = page.map((r) => r.userWawuId);
      const members = ids.filter((id) => id !== community.hostWawuId);
      const [lapsed, markers, blocks, counted] = await Promise.all([
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
        // How far each person's notices for this room have counted: the
        // largest `countedUpTo` of ALL their notices for it, read ones too.
        this.prisma.communityMessageNotice.groupBy({
          by: ['userWawuId'],
          where: { communityId, userWawuId: { in: ids } },
          _max: { countedUpTo: true },
        }),
      ]);
      const readAt = new Map(markers.map((m) => [m.userWawuId, m.lastReadAt]));
      const countedTo = new Map(
        counted.map((c) => [c.userWawuId, c._max.countedUpTo]),
      );
      const blockedPairs = new Set<string>();
      for (const b of blocks) {
        blockedPairs.add(`${b.userWawuId}|${b.blockedWawuId}`);
        blockedPairs.add(`${b.blockedWawuId}|${b.userWawuId}`);
      }

      const entries: CommunityMessageEntry[] = [];
      for (const r of page) {
        if (lapsed.has(r.userWawuId)) continue;
        const lastReadAt = readAt.get(r.userWawuId) ?? null;
        const since = laterOf(
          laterOf(lastReadAt, r.joinedAt),
          countedTo.get(r.userWawuId) ?? null,
        );
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

/** When to try a failed room again: the base wait, doubling with each failure up to the cap. */
function retryAt(attempts: number): Date {
  const wait = Math.min(
    COMMUNITY_NOTICE_RETRY_BASE_SECONDS * 2 ** Math.max(0, attempts - 1),
    COMMUNITY_NOTICE_RETRY_MAX_SECONDS,
  );
  return new Date(Date.now() + wait * 1000);
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
