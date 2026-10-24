import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { koboNumber } from '../ledger/ledger.service';
import { knownReviewReason } from './earning-review-reasons';
import type {
  EarningInReviewKind,
  EarningInReviewView,
  EarningsInReviewPage,
} from './earning-review.type';

/**
 * The earnings a person has to look at (OPS-26, lead ruling 24 Oct 2026, the
 * owner may override), for `GET /admin/money/earnings/in-review`.
 *
 * Two kinds of row can be in review (R-55): a daily move (`EarningMove`), which
 * the wallet first refused 72 hours ago or which the sweep could not decide,
 * and a single earning (`EarningSettlement`) that was taken out of its move.
 * An earning that travels in a move in review carries no mark of its own: the
 * move is the row, so nothing is listed twice.
 *
 * Read only: it moves no money, calls no provider and changes no row. Each
 * amount is the row's own kobo; nothing is added up, because the provider's
 * balance is the truth. Oldest first, a cursor page.
 */

export const BAD_REVIEW_CURSOR_MESSAGE = 'cursor is not one this list gave.';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** A reason is made of our own sentences (earning-review-reasons.ts); this only guards the page's size. */
const REASON_MAX = 400;
const PREFIX = 'r1.';
const RANK: Record<EarningInReviewKind, number> = {
  daily_move: 0,
  earning: 1,
};
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** The keyset condition after a cursor, in a shape both tables' filters accept. */
type AfterCursor = {
  OR?: Array<{ reviewSince: Date | { gt: Date }; id?: { gt: string } }>;
};

/** Where a page stopped: the last row's time, kind and id. */
export interface ReviewPosition {
  at: Date;
  kind: EarningInReviewKind;
  id: string;
}

export function encodeReviewCursor(p: ReviewPosition): string {
  return (
    PREFIX +
    Buffer.from(
      JSON.stringify([p.at.toISOString(), p.kind, p.id]),
      'utf8',
    ).toString('base64url')
  );
}

export function decodeReviewCursor(raw: string): ReviewPosition {
  const bad = () => new BadRequestException(BAD_REVIEW_CURSOR_MESSAGE);
  if (!raw.startsWith(PREFIX)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    !(parsed[1] in RANK) ||
    !ID_SHAPE.test(parsed[2])
  ) {
    throw bad();
  }
  const at = new Date(parsed[0]);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== parsed[0]) throw bad();
  return { at, kind: parsed[1] as EarningInReviewKind, id: parsed[2] };
}

function clip(note: string | null): string | null {
  if (!note) return null;
  return note.length > REASON_MAX ? `${note.slice(0, REASON_MAX)}...` : note;
}

@Injectable()
export class EarningsInReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async inReview(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<EarningsInReviewPage> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const after = opts.cursor ? decodeReviewCursor(opts.cursor) : null;

    const inReview = { status: 'owed', reviewSince: { not: null } } as const;
    const rowsAfter = (kind: EarningInReviewKind): AfterCursor => {
      if (!after) return {};
      // The order is (time, kind, id): a daily move comes before an earning
      // made at the same moment, and ids follow the database's own order.
      const sameMoment: Array<{ reviewSince: Date; id?: { gt: string } }> = [];
      if (RANK[kind] > RANK[after.kind]) {
        sameMoment.push({ reviewSince: after.at });
      } else if (kind === after.kind) {
        sameMoment.push({ reviewSince: after.at, id: { gt: after.id } });
      }
      return { OR: [{ reviewSince: { gt: after.at } }, ...sameMoment] };
    };

    const [moves, earnings, movesIn, earningsIn] = await Promise.all([
      this.prisma.earningMove.findMany({
        where: { AND: [inReview, rowsAfter('daily_move')] },
        orderBy: [{ reviewSince: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        select: {
          id: true,
          payeeWawuUserId: true,
          dayKey: true,
          provider: true,
          amountKobo: true,
          earnings: true,
          firstRefusedAt: true,
          reviewSince: true,
          discrepancy: true,
        },
      }),
      this.prisma.earningSettlement.findMany({
        where: { AND: [inReview, rowsAfter('earning')] },
        orderBy: [{ reviewSince: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        select: {
          id: true,
          payeeWawuUserId: true,
          title: true,
          provider: true,
          amountKobo: true,
          reviewSince: true,
          discrepancy: true,
        },
      }),
      this.prisma.earningMove.count({ where: inReview }),
      this.prisma.earningSettlement.count({ where: inReview }),
    ]);

    const rows: Array<{ at: Date; view: EarningInReviewView }> = [
      ...moves.map((m) => ({
        at: m.reviewSince!,
        view: {
          id: m.id,
          kind: 'daily_move' as const,
          payeeWawuUserId: m.payeeWawuUserId,
          amountKobo: koboNumber(m.amountKobo),
          earnings: m.earnings,
          title: null,
          dayKey: m.dayKey,
          provider: m.provider,
          firstRefusedAt: m.firstRefusedAt?.toISOString() ?? null,
          reviewSince: m.reviewSince!.toISOString(),
          reason: clip(knownReviewReason(m.discrepancy)),
        },
      })),
      ...earnings.map((s) => ({
        at: s.reviewSince!,
        view: {
          id: s.id,
          kind: 'earning' as const,
          payeeWawuUserId: s.payeeWawuUserId,
          amountKobo: koboNumber(s.amountKobo),
          earnings: 1,
          title: s.title,
          dayKey: null,
          provider: s.provider,
          firstRefusedAt: null,
          reviewSince: s.reviewSince!.toISOString(),
          reason: clip(knownReviewReason(s.discrepancy)),
        },
      })),
    ].sort(
      // Stable: within a kind the database's order (time, then id) is kept.
      (a, b) =>
        a.at.getTime() - b.at.getTime() ||
        RANK[a.view.kind] - RANK[b.view.kind],
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      count: movesIn + earningsIn,
      items: page.map((r) => r.view),
      nextCursor:
        rows.length > limit && last
          ? encodeReviewCursor({
              at: last.at,
              kind: last.view.kind,
              id: last.view.id,
            })
          : null,
    };
  }
}
