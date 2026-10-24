import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { reviewStageOf } from '../../money/opening/review-stage';
import type {
  HeldOpeningState,
  IdentityHoldsPage,
  OpeningReviewStage,
  StuckOpeningsPage,
  StuckOpeningState,
} from './admin-opening-lists.type';

/**
 * Wallet openings that are stuck, and identity holds (OPS-26, lead ruling 24
 * Oct 2026, the owner may override): the two lists support could not see
 * (G-OPS-25-2, G-OPS-25-3 in the mobile repo's BACKEND_GAPS.md).
 *
 * Read only. Each list answers by WAWU account id and our own words: never a
 * BVN, a hash, a phone number or a name, and never the provider's text. Both
 * are cursor pages (CONVENTIONS section 6), oldest first. The ordering text
 * key is compared `COLLATE "C"`, as that section asks, so a page and its
 * cursor agree on every database.
 *
 * - **Stuck**: an opening with no wallet that is waiting on the provider or on
 *   a person. `conflict` (held for a hand look, G-37) is listed at once; an
 *   `opening`, `unknown` or `open` row is listed once its attempt is
 *   STUCK_AFTER_MINUTES old. Openings with a step for the PERSON to take
 *   (`review`, `stopped`, `failed`) or closed (`expired`) are not stuck.
 * - **Hold**: an opening in `review` or `stopped` that still holds its BVN and
 *   has no wallet: exactly the openings the release route can let go of.
 */

export const STUCK_AFTER_MINUTES = 60;
export const BAD_OPENING_CURSOR_MESSAGE = 'cursor is not one this list gave.';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PREFIX = 'o1.';
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** A failure is our own code (snake_case); anything else is not sent. */
const CODE_SHAPE = /^[a-z0-9_]{1,80}$/;
/** What `FintavaWalletOpening.bvnHash` starts with once nobody holds the number (src/money/opening/bvn-claim.ts). */
const RELEASED_PREFIX = 'released:';

interface Position {
  at: Date;
  id: string;
}

export function encodeOpeningCursor(p: Position): string {
  return (
    PREFIX +
    Buffer.from(JSON.stringify([p.at.toISOString(), p.id]), 'utf8').toString(
      'base64url',
    )
  );
}

export function decodeOpeningCursor(raw: string): Position {
  const bad = () => new BadRequestException(BAD_OPENING_CURSOR_MESSAGE);
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
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !ID_SHAPE.test(parsed[1])
  ) {
    throw bad();
  }
  const at = new Date(parsed[0]);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== parsed[0]) throw bad();
  return { at, id: parsed[1] };
}

interface OpeningRow {
  wawuUserId: string;
  state: string;
  failure: string | null;
  provider: string | null;
  attempts: number;
  attemptStartedAt: Date;
  bvnVerifiedAt: Date;
  updatedAt: Date;
}

const codeOf = (failure: string | null): string | null =>
  failure && CODE_SHAPE.test(failure) ? failure : null;

/** `null` provider is Fintava's (a row from before the column). */
const providerOf = (value: string | null): string => value ?? 'fintava';

@Injectable()
export class AdminOpeningListsService {
  constructor(private readonly prisma: PrismaService) {}

  async stuck(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<StuckOpeningsPage> {
    const limit = clampLimit(opts.limit);
    const after = opts.cursor ? decodeOpeningCursor(opts.cursor) : null;
    const [{ now }] = await this.prisma.$queryRaw<
      Array<{ now: Date | string }>
    >`
      SELECT now() AS "now"
    `;
    const cutoff = new Date(
      new Date(now).getTime() - STUCK_AFTER_MINUTES * 60_000,
    );
    const stuck = Prisma.sql`
      NOT EXISTS (SELECT 1 FROM "FintavaWallet" w WHERE w."wawuUserId" = o."wawuUserId")
      AND (
        o."state" = 'conflict'
        OR (o."state" IN ('opening', 'unknown', 'open') AND o."attemptStartedAt" < ${cutoff})
      )`;
    const rows = await this.prisma.$queryRaw<OpeningRow[]>`
      SELECT o."wawuUserId", o."state", o."failure", o."provider", o."attempts",
             o."attemptStartedAt", o."bvnVerifiedAt", o."updatedAt"
      FROM "FintavaWalletOpening" o
      WHERE ${stuck}
        ${after ? this.after(Prisma.sql`o."attemptStartedAt"`, after) : Prisma.empty}
      ORDER BY o."attemptStartedAt" ASC, o."wawuUserId" COLLATE "C" ASC
      LIMIT ${limit + 1}`;
    const [{ n }] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS "n" FROM "FintavaWalletOpening" o WHERE ${stuck}`;

    const page = rows.slice(0, limit);
    const stages = await this.stages(page.map((r) => r.wawuUserId));
    const last = page[page.length - 1];
    return {
      stuckAfterMinutes: STUCK_AFTER_MINUTES,
      count: Number(n),
      items: page.map((r) => ({
        wawuUserId: r.wawuUserId,
        state: r.state as StuckOpeningState,
        failureCode: codeOf(r.failure),
        provider: providerOf(r.provider),
        attempts: r.attempts,
        startedAt: r.attemptStartedAt.toISOString(),
        stage: stages.get(r.wawuUserId) ?? null,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeOpeningCursor({
              at: last.attemptStartedAt,
              id: last.wawuUserId,
            })
          : null,
    };
  }

  async holds(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<IdentityHoldsPage> {
    const limit = clampLimit(opts.limit);
    const after = opts.cursor ? decodeOpeningCursor(opts.cursor) : null;
    const held = Prisma.sql`
      o."state" IN ('review', 'stopped')
      AND o."bvnHash" NOT LIKE ${`${RELEASED_PREFIX}%`}
      AND NOT EXISTS (SELECT 1 FROM "FintavaWallet" w WHERE w."wawuUserId" = o."wawuUserId")`;
    const rows = await this.prisma.$queryRaw<OpeningRow[]>`
      SELECT o."wawuUserId", o."state", o."failure", o."provider", o."attempts",
             o."attemptStartedAt", o."bvnVerifiedAt", o."updatedAt"
      FROM "FintavaWalletOpening" o
      WHERE ${held}
        ${after ? this.after(Prisma.sql`o."bvnVerifiedAt"`, after) : Prisma.empty}
      ORDER BY o."bvnVerifiedAt" ASC, o."wawuUserId" COLLATE "C" ASC
      LIMIT ${limit + 1}`;
    const [{ n }] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS "n" FROM "FintavaWalletOpening" o WHERE ${held}`;

    const page = rows.slice(0, limit);
    const stages = await this.stages(page.map((r) => r.wawuUserId));
    const last = page[page.length - 1];
    return {
      count: Number(n),
      items: page.map((r) => ({
        wawuUserId: r.wawuUserId,
        state: r.state as HeldOpeningState,
        stage: stages.get(r.wawuUserId) ?? null,
        failureCode: codeOf(r.failure),
        provider: providerOf(r.provider),
        heldSince: r.bvnVerifiedAt.toISOString(),
        changedAt: r.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeOpeningCursor({ at: last.bvnVerifiedAt, id: last.wawuUserId })
          : null,
    };
  }

  /** The keyset condition after a cursor, on the list's own time column. */
  private after(column: Prisma.Sql, p: Position): Prisma.Sql {
    return Prisma.sql`AND (${column} > ${p.at} OR (${column} = ${p.at} AND o."wawuUserId" COLLATE "C" > ${p.id}))`;
  }

  /**
   * Where the provider's own review of each person stands, from what WAWU
   * stores of it (NuvionEntity). Only the stage word is read: never the
   * numbers, the documents or the provider's reasons.
   */
  private async stages(
    ids: string[],
  ): Promise<Map<string, OpeningReviewStage>> {
    const out = new Map<string, OpeningReviewStage>();
    if (ids.length === 0) return out;
    const entities = await this.prisma.nuvionEntity.findMany({
      where: { wawuUserId: { in: ids } },
      select: {
        wawuUserId: true,
        status: true,
        decidedAt: true,
        correctedAt: true,
        bvnStatus: true,
        ninStatus: true,
        documentStatus: true,
        addressProofStatus: true,
      },
    });
    for (const e of entities) {
      out.set(e.wawuUserId, reviewStageOf({ ...e, rejectionReasons: [] }));
    }
    return out;
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}
