import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type {
  DirectMessageModel as DirectMessageRow,
  DmReplyModel as DmReplyRow,
} from '../../generated/prisma/models';
import { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import type { DmOtherParty } from '../common/types';
import { DirectMessageService } from './direct-message.service';
import { DmReplyWriter } from './dm-reply-writer';
import type {
  PaidDmQuestion,
  PaidDmQueueItem,
  PaidDmQueuePage,
  PaidDmSide,
  PaidDmThread,
  PaidDmThreadDetail,
  PaidDmThreadPage,
} from './paid-dm-view.type';

const DEFAULT_PAGE_SIZE = 20;

/** A cursor is a time and an id, base64url so the app treats it as opaque. */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
): { at: Date; id: string } | null {
  if (cursor === undefined) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = raw.indexOf('|');
  const at = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (bar < 1 || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new BadRequestException('cursor is not one this server gave out');
  }
  return { at, id };
}

/** lookupOtherParties answers every id it is given; this is only the type's way out. */
function unknownParty(wawuId: string): DmOtherParty {
  return {
    wawuId,
    name: '',
    handle: null,
    avatarUrl: null,
    verification: deriveVerificationState(null),
  };
}

/** A paid question's price is whole naira on the row; the contract speaks kobo. */
const toKobo = (naira: number): number => naira * 100;

interface ThreadAggRow {
  other: string;
  questions: number;
  waiting: number;
  next_deadline: Date | null;
  last_at: Date;
}

interface LastBubbleRow {
  other: string;
  text: string;
  at: Date;
}

/**
 * Paid questions as threads, and the creator's waiting list (task INBOX-08).
 *
 * New routes only: the older `/dm/*` routes still answer one row per
 * question. A thread is every question between one fan and one creator, with
 * every reply bubble the creator gave each of them. Nothing here moves
 * money; paying, holding and refunding belong to INBOX-17.
 *
 * "Waiting" means open AND inside its window. A question past its deadline
 * that the sweep has not yet flipped can no longer be answered (the reply
 * route refuses it), so it is not in the queue and not in the total.
 */
@Injectable()
export class PaidDmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dms: DirectMessageService,
    private readonly replyWriter: DmReplyWriter,
  ) {}

  /** The creator's own waiting list: soonest deadline first, with the total. */
  async queue(
    creatorWawuId: string,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<PaidDmQueuePage> {
    const now = new Date();
    const after = decodeCursor(cursor);
    const waiting: Prisma.DirectMessageWhereInput = {
      creatorWawuId,
      status: 'awaiting_response',
      deadlineAt: { gt: now },
    };
    const [rows, waitingTotal] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: {
          AND: [
            waiting,
            after
              ? {
                  OR: [
                    { deadlineAt: { gt: after.at } },
                    { deadlineAt: after.at, id: { gt: after.id } },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
      this.prisma.directMessage.count({ where: waiting }),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const senders = await this.dms.lookupOtherParties(
      page.map((r) => r.senderWawuId),
    );
    const items: PaidDmQueueItem[] = page.map((r) => ({
      id: r.id,
      text: r.text,
      amountKobo: toKobo(r.amount),
      sentAt: r.sentAt.toISOString(),
      deadlineAt: r.deadlineAt.toISOString(),
      sender: senders.get(r.senderWawuId) ?? unknownParty(r.senderWawuId),
    }));
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.deadlineAt, last.id)
          : null,
      waitingTotal,
    };
  }

  /** The caller's threads, latest activity first, one per other person. */
  async threads(
    me: string,
    side: PaidDmSide,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<PaidDmThreadPage> {
    const after = decodeCursor(cursor);
    const rows = await this.aggregate(me, side, undefined, after, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.toThreads(me, side, page),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.last_at, last.other)
          : null,
    };
  }

  /** One thread with every question and reply, newest question first. */
  async thread(
    me: string,
    side: PaidDmSide,
    otherWawuId: string,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<PaidDmThreadDetail> {
    const [agg] = await this.aggregate(me, side, otherWawuId, null, 1);
    if (!agg) throw new NotFoundException('No paid questions with this person');
    const before = decodeCursor(cursor);
    const rows = await this.prisma.directMessage.findMany({
      where: {
        ...this.pair(me, side, otherWawuId),
        ...(before
          ? {
              OR: [
                { sentAt: { lt: before.at } },
                { sentAt: before.at, id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { replies: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const [thread] = await this.toThreads(me, side, [agg]);
    return {
      thread,
      questions: page.map((r) => this.toQuestion(me, r, r.replies)),
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.sentAt, last.id) : null,
    };
  }

  /** The creator adds a reply bubble to a question sent to them. */
  async reply(
    creatorWawuId: string,
    messageId: string,
    text: string,
  ): Promise<PaidDmQuestion> {
    await this.replyWriter.post(creatorWawuId, messageId, text, 'any');
    const row = await this.prisma.directMessage.findUniqueOrThrow({
      where: { id: messageId },
      include: { replies: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    return this.toQuestion(creatorWawuId, row, row.replies);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private pair(
    me: string,
    side: PaidDmSide,
    other: string,
  ): Prisma.DirectMessageWhereInput {
    return side === 'fan'
      ? { senderWawuId: me, creatorWawuId: other }
      : { creatorWawuId: me, senderWawuId: other };
  }

  private toQuestion(
    me: string,
    r: DirectMessageRow,
    replies: DmReplyRow[],
  ): PaidDmQuestion {
    return {
      id: r.id,
      text: r.text,
      amountKobo: toKobo(r.amount),
      status: r.status,
      mine: r.senderWawuId === me,
      sentAt: r.sentAt.toISOString(),
      deadlineAt: r.deadlineAt.toISOString(),
      respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
      replies: replies.map((x) => ({
        id: x.id,
        text: x.text,
        createdAt: x.createdAt.toISOString(),
      })),
    };
  }

  /**
   * One row per other person: counts, the soonest open deadline and the
   * latest activity (a question or a reply). Raw SQL because the grouping and
   * the activity time span two tables; every value reaches it as a parameter.
   */
  private async aggregate(
    me: string,
    side: PaidDmSide,
    other: string | undefined,
    after: { at: Date; id: string } | null,
    take: number,
  ): Promise<ThreadAggRow[]> {
    const meCol = Prisma.raw(
      side === 'fan' ? '"senderWawuId"' : '"creatorWawuId"',
    );
    const otherCol = Prisma.raw(
      side === 'fan' ? '"creatorWawuId"' : '"senderWawuId"',
    );
    const now = new Date();
    const nowTs = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    const waiting = Prisma.sql`d."status" = 'awaiting_response' AND d."deadlineAt" > ${nowTs}`;
    const rows = await this.prisma.$queryRaw<
      {
        other: string;
        questions: bigint;
        waiting: bigint;
        next_deadline: Date | null;
        last_at: Date;
      }[]
    >(Prisma.sql`
      SELECT * FROM (
        SELECT d.${otherCol} AS other,
               count(DISTINCT d."id") AS questions,
               count(DISTINCT d."id") FILTER (WHERE ${waiting}) AS waiting,
               min(d."deadlineAt") FILTER (WHERE ${waiting}) AS next_deadline,
               GREATEST(max(d."sentAt"), max(r."createdAt")) AS last_at
        FROM "DirectMessage" d
        LEFT JOIN "DmReply" r ON r."messageId" = d."id"
        WHERE d.${meCol} = ${me}
          ${other === undefined ? Prisma.empty : Prisma.sql`AND d.${otherCol} = ${other}`}
        GROUP BY d.${otherCol}
      ) t
      ${
        after
          ? Prisma.sql`WHERE t.last_at < (${after.at.toISOString()}::timestamptz AT TIME ZONE 'UTC')
             OR (t.last_at = (${after.at.toISOString()}::timestamptz AT TIME ZONE 'UTC') AND t.other < ${after.id})`
          : Prisma.empty
      }
      ORDER BY t.last_at DESC, t.other DESC
      LIMIT ${take}
    `);
    return rows.map((r) => ({
      other: r.other,
      questions: Number(r.questions),
      waiting: Number(r.waiting),
      next_deadline: r.next_deadline,
      last_at: r.last_at,
    }));
  }

  private async toThreads(
    me: string,
    side: PaidDmSide,
    aggs: ThreadAggRow[],
  ): Promise<PaidDmThread[]> {
    if (aggs.length === 0) return [];
    const others = aggs.map((a) => a.other);
    const meCol = Prisma.raw(
      side === 'fan' ? '"senderWawuId"' : '"creatorWawuId"',
    );
    const otherCol = Prisma.raw(
      side === 'fan' ? '"creatorWawuId"' : '"senderWawuId"',
    );
    const [parties, questions, replies] = await Promise.all([
      this.dms.lookupOtherParties(others),
      this.prisma.$queryRaw<LastBubbleRow[]>(Prisma.sql`
        SELECT DISTINCT ON (d.${otherCol}) d.${otherCol} AS other, d."text" AS text, d."sentAt" AS at
        FROM "DirectMessage" d
        WHERE d.${meCol} = ${me} AND d.${otherCol} IN (${Prisma.join(others)})
        ORDER BY d.${otherCol}, d."sentAt" DESC, d."id" DESC`),
      this.prisma.$queryRaw<LastBubbleRow[]>(Prisma.sql`
        SELECT DISTINCT ON (d.${otherCol}) d.${otherCol} AS other, r."text" AS text, r."createdAt" AS at
        FROM "DmReply" r JOIN "DirectMessage" d ON d."id" = r."messageId"
        WHERE d.${meCol} = ${me} AND d.${otherCol} IN (${Prisma.join(others)})
        ORDER BY d.${otherCol}, r."createdAt" DESC, r."id" DESC`),
    ]);
    const lastQ = new Map(questions.map((q) => [q.other, q]));
    const lastR = new Map(replies.map((q) => [q.other, q]));
    return aggs.map((a) => {
      const q = lastQ.get(a.other);
      const r = lastR.get(a.other);
      // A reply is always later than the question it answers; on a tie it wins.
      const replyLast =
        r !== undefined && (!q || r.at.getTime() >= q.at.getTime());
      const bubble = replyLast ? r : q;
      const fanWrote = !replyLast;
      return {
        other: parties.get(a.other) ?? unknownParty(a.other),
        side,
        questionCount: a.questions,
        waitingCount: a.waiting,
        nextDeadlineAt: a.next_deadline ? a.next_deadline.toISOString() : null,
        lastActivityAt: a.last_at.toISOString(),
        lastText: bubble?.text ?? '',
        lastTextMine: side === 'fan' ? fanWrote : !fanWrote,
      };
    });
  }
}
