import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type {
  PointHoldPurpose,
  PointHoldState,
  PointLotSource,
} from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  POINTS_EXPIRY,
  POINTS_LATEST_END,
  POINTS_LIMITS,
  POINTS_VIEW,
} from './points-config';
import { lockPersonPoints } from './points-lock';
import { PointsError } from './points-error';
import { POINT_LOT_LABELS, pointMovementLabel } from './points-labels';
import type { MyPointsView, PointMovementView } from './points-view.type';

type Tx = Prisma.TransactionClient;

/** A grant: a new lot for one person (TIER-03, POINTS-02, POINTS-03, REF-01). */
export interface PointGrantInput {
  wawuUserId: string;
  source: PointLotSource;
  /** The granting task's own reference: a purchase, a referral, a job. */
  sourceRef: string;
  /** A whole number of points above zero. */
  points: number;
  /** When the lot ends; must be after now. */
  expiresAt: Date;
}

export interface PointGrantOutcome {
  lotId: string;
  /** False when this source and reference had already granted the lot. */
  granted: boolean;
  points: number;
  expiresAt: Date;
}

/** A hold: points taken from a person's lots for one job (POINTS-03, POINTS-04). */
export interface PointHoldInput {
  wawuUserId: string;
  purpose: PointHoldPurpose;
  /** The job or conversion it pays for; one hold per purpose and reference. */
  reference: string;
  points: number;
  /** The tool's name from the calling task's own table ("VoiceOver"). */
  title?: string;
}

/** Which hold: by its id, or by the purpose and reference it was made with. */
export type PointHoldKey =
  { holdId: string } | { purpose: PointHoldPurpose; reference: string };

export interface PointHoldOutcome {
  holdId: string;
  wawuUserId: string;
  state: PointHoldState;
  points: number;
  /** Where the points came from, soonest-expiring lot first. */
  parts: Array<{ lotId: string; points: number }>;
  /** True when the call found the hold already in this state and changed nothing. */
  replayed: boolean;
}

export interface PointsExpiryOutcome {
  /** Lots whose remaining points the pass took away (one ledger row each). */
  lots: number;
  points: number;
  /** Lots the database refused to write off; each is logged by id. */
  failed: number;
}

/** Optional: the caller's transaction, and the time to act as of (tests). */
export interface PointsCallOptions {
  tx?: Tx;
  now?: Date;
}

/**
 * Points, held in lots that expire, and the append-only ledger of every
 * change to them (task POINTS-01, R-43, the owner's brief section 3).
 *
 * Points are WAWU's own instrument for the AI tools, always a count, never
 * naira or dollars, separate from WAWU Credits, and never money a provider
 * holds: the lots are the authority for a person's points, and the balance is
 * the sum of their live lots (a lot that has not ended). A money balance is
 * never computed this way; that is the wallet provider's alone.
 *
 * Every write takes the person's points lock (a transaction advisory lock on
 * `points:<wawuUserId>`) first, so two calls for one person run one after the
 * other and a hold always sees the lots as the last call left them. Under
 * the lock a lot is still taken by a guarded update (`remaining >= n`), and
 * the database refuses a lot below zero or above what it was granted, a lot
 * whose points differ from the sum of its ledger rows, and any UPDATE of a
 * ledger row (the migration's CHECKs and triggers). So a failure here rolls
 * back; it never leaves a lot and its ledger apart.
 *
 * Callers that grant or spend inside their own transaction (a payment that
 * sets a tier and grants its bonus in one commit) pass it as `tx`. It must be
 * READ COMMITTED, Postgres's default and Prisma's.
 */
@Injectable()
export class PointsService {
  private readonly logger = new Logger(PointsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Adds a lot. Idempotent on (source, sourceRef): the same grant again
   * returns the first lot and writes nothing, and the first grant's end date
   * stands, so a replayed payment webhook that computes another end date
   * still grants once. The same reference for another person or another
   * amount is `points_grant_conflict`.
   */
  async grant(
    input: PointGrantInput,
    opts: PointsCallOptions = {},
  ): Promise<PointGrantOutcome> {
    const now = opts.now ?? new Date();
    requirePerson(input.wawuUserId);
    requireReference(input.sourceRef);
    requirePoints(input.points);
    if (
      !(input.expiresAt instanceof Date) ||
      Number.isNaN(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= now.getTime()
    ) {
      throw new PointsError('points_invalid', 'Points must end in the future.');
    }
    // The migration's CHECK holds the same bound: an end Postgres can store
    // but JavaScript cannot read back (after the year 9999) never gets in, so
    // no person's points view can fail on a stored date.
    if (input.expiresAt.getTime() >= POINTS_LATEST_END.getTime()) {
      throw new PointsError('points_invalid', 'That end date is too far away.');
    }

    return this.inTx(opts.tx, async (tx) => {
      await lockPersonPoints(tx, input.wawuUserId);
      const lotId = randomUUID();
      // INSERT ... ON CONFLICT DO NOTHING: a grant that loses a race on the
      // same source and reference writes nothing and reads the winner below.
      const { count } = await tx.pointLot.createMany({
        data: [
          {
            id: lotId,
            wawuUserId: input.wawuUserId,
            source: input.source,
            sourceRef: input.sourceRef,
            quantity: input.points,
            remaining: input.points,
            expiresAt: input.expiresAt,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) {
        const first = await tx.pointLot.findUnique({
          where: {
            source_sourceRef: {
              source: input.source,
              sourceRef: input.sourceRef,
            },
          },
        });
        if (
          !first ||
          first.wawuUserId !== input.wawuUserId ||
          first.quantity !== input.points
        ) {
          throw new PointsError(
            'points_grant_conflict',
            'These points were already added with different details.',
          );
        }
        return {
          lotId: first.id,
          granted: false,
          points: first.quantity,
          expiresAt: first.expiresAt,
        };
      }
      await tx.pointLedger.create({
        data: {
          wawuUserId: input.wawuUserId,
          lotId,
          delta: input.points,
          reason: 'grant',
          reference: input.sourceRef,
        },
      });
      return {
        lotId,
        granted: true,
        points: input.points,
        expiresAt: input.expiresAt,
      };
    });
  }

  /**
   * Takes points from the person's live lots, the soonest-expiring first
   * (then the oldest grant, then the lot id, so the order is total), one
   * ledger row per lot touched. More than the balance is
   * `insufficient_points` with the balance and the shortfall, and nothing is
   * written. Idempotent on (purpose, reference): the same hold again returns
   * the first one in whatever state it is now; another person or amount is
   * `points_hold_conflict`.
   */
  async hold(
    input: PointHoldInput,
    opts: PointsCallOptions = {},
  ): Promise<PointHoldOutcome> {
    const now = opts.now ?? new Date();
    requirePerson(input.wawuUserId);
    requireReference(input.reference);
    requirePoints(input.points);
    const title = input.title?.trim() || null;
    if (title !== null && title.length > POINTS_LIMITS.titleLength) {
      throw new PointsError('points_invalid', 'That title is too long.');
    }

    return this.inTx(opts.tx, async (tx) => {
      await lockPersonPoints(tx, input.wawuUserId);
      const existing = await tx.pointHold.findUnique({
        where: {
          purpose_reference: {
            purpose: input.purpose,
            reference: input.reference,
          },
        },
      });
      if (existing) {
        if (
          existing.wawuUserId !== input.wawuUserId ||
          existing.quantity !== input.points
        ) {
          throw new PointsError(
            'points_hold_conflict',
            'These points were already held with different details.',
          );
        }
        return outcomeOf(tx, existing, true);
      }

      const lots = await tx.pointLot.findMany({
        where: {
          wawuUserId: input.wawuUserId,
          remaining: { gt: 0 },
          expiresAt: { gt: now },
        },
        select: { id: true, remaining: true },
        orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const balance = lots.reduce((sum, lot) => sum + lot.remaining, 0);
      if (balance < input.points) {
        throw new PointsError(
          'insufficient_points',
          "You don't have enough points for this.",
          {
            balancePoints: balance,
            neededPoints: input.points,
            shortfallPoints: input.points - balance,
          },
        );
      }

      // INSERT ... ON CONFLICT DO NOTHING, as a grant does: two people asking
      // for one purpose and reference at the same moment take different
      // person locks, so the loser of the unique index writes nothing and is
      // answered as if it had come second.
      const holdId = randomUUID();
      const { count } = await tx.pointHold.createMany({
        data: [
          {
            id: holdId,
            wawuUserId: input.wawuUserId,
            purpose: input.purpose,
            reference: input.reference,
            title,
            quantity: input.points,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) {
        const winner = await tx.pointHold.findUniqueOrThrow({
          where: {
            purpose_reference: {
              purpose: input.purpose,
              reference: input.reference,
            },
          },
        });
        if (
          winner.wawuUserId !== input.wawuUserId ||
          winner.quantity !== input.points
        ) {
          throw new PointsError(
            'points_hold_conflict',
            'These points were already held with different details.',
          );
        }
        return outcomeOf(tx, winner, true);
      }
      const hold = {
        id: holdId,
        wawuUserId: input.wawuUserId,
        quantity: input.points,
        state: 'held' as const,
      };
      const parts: PointHoldOutcome['parts'] = [];
      let left = input.points;
      for (const lot of lots) {
        if (left === 0) break;
        const take = Math.min(left, lot.remaining);
        await takeFromLot(tx, lot.id, take);
        await tx.pointLedger.create({
          data: {
            wawuUserId: input.wawuUserId,
            lotId: lot.id,
            delta: -take,
            reason: 'hold',
            holdId: hold.id,
            reference: input.reference,
          },
        });
        parts.push({ lotId: lot.id, points: take });
        left -= take;
      }
      return {
        holdId: hold.id,
        wawuUserId: hold.wawuUserId,
        state: hold.state,
        points: hold.quantity,
        parts,
        replayed: false,
      };
    });
  }

  /**
   * The job ran: the held points are spent. No lot changes (the hold already
   * took them), so no ledger row is written; the hold's own rows now read
   * "Spent on ...". Committing again changes nothing; committing a released
   * hold is `points_hold_settled`.
   */
  async commit(
    key: PointHoldKey,
    opts: PointsCallOptions = {},
  ): Promise<PointHoldOutcome> {
    const now = opts.now ?? new Date();
    return this.settle(key, 'committed', now, opts.tx);
  }

  /**
   * The job did not run: every held point goes back to the lot it came from,
   * one `release` ledger row per lot. A lot that ended while its points were
   * held takes them back and loses them in the same transaction (a
   * `release` row, then an `expire` row), so ended points never count.
   * Releasing again changes nothing; releasing a committed hold is
   * `points_hold_settled`.
   */
  async release(
    key: PointHoldKey,
    opts: PointsCallOptions = {},
  ): Promise<PointHoldOutcome> {
    const now = opts.now ?? new Date();
    return this.settle(key, 'released', now, opts.tx);
  }

  /**
   * The expiry job's one pass: each lot that has ended with points still in
   * it loses them, with one `expire` ledger row. Lots are re-read under the
   * person's lock, so two servers running the pass at once write each row
   * once. A lot that ended empty writes nothing.
   */
  async expireLapsed(now: Date = new Date()): Promise<PointsExpiryOutcome> {
    const due = await this.prisma.pointLot.findMany({
      where: { remaining: { gt: 0 }, expiresAt: { lte: now } },
      select: { id: true, wawuUserId: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: POINTS_EXPIRY.batch,
    });
    const outcome: PointsExpiryOutcome = { lots: 0, points: 0, failed: 0 };
    for (const candidate of due) {
      let taken: number;
      try {
        taken = await this.expireOne(candidate, now);
      } catch (e) {
        // One lot the database refused (its points no longer match its
        // ledger) stops for that lot only and is reported, never forced:
        // the rest of the pass goes on.
        outcome.failed += 1;
        this.logger.error(
          `points expiry: lot ${candidate.id} was not written off (${(e as Error).name ?? 'Error'})`,
        );
        continue;
      }
      if (taken > 0) {
        outcome.lots += 1;
        outcome.points += taken;
      }
    }
    return outcome;
  }

  /** Writes off one lapsed lot under its person's lock; 0 if nothing was left. */
  private expireOne(
    candidate: { id: string; wawuUserId: string },
    now: Date,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await lockPersonPoints(tx, candidate.wawuUserId);
      const lot = await tx.pointLot.findUnique({
        where: { id: candidate.id },
      });
      if (!lot || lot.remaining === 0 || lot.expiresAt > now) return 0;
      await takeFromLot(tx, lot.id, lot.remaining, now);
      await tx.pointLedger.create({
        data: {
          wawuUserId: lot.wawuUserId,
          lotId: lot.id,
          delta: -lot.remaining,
          reason: 'expire',
        },
      });
      return lot.remaining;
    });
  }

  /**
   * PT5: the caller's balance, their live lots soonest-expiring first, the
   * soonest points to end, and the last 20 ledger rows, newest first. Only
   * the given person's rows are read.
   */
  async view(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<MyPointsView> {
    const live = {
      wawuUserId,
      remaining: { gt: 0 },
      expiresAt: { gt: now },
    };
    // One snapshot, so the balance, the lots and the movements agree with
    // each other even while a hold or a grant lands.
    const [sum, lotCount, soonestEnd, lots, rows] =
      await this.prisma.$transaction(
        [
          this.prisma.pointLot.aggregate({
            where: live,
            _sum: { remaining: true },
          }),
          this.prisma.pointLot.count({ where: live }),
          // The soonest end and every point that ends then, over all of the
          // person's live lots, not only the ones listed.
          this.prisma.pointLot.groupBy({
            by: ['expiresAt'],
            where: live,
            _sum: { remaining: true },
            orderBy: { expiresAt: 'asc' },
            take: 1,
          }),
          this.prisma.pointLot.findMany({
            where: live,
            orderBy: [
              { expiresAt: 'asc' },
              { createdAt: 'asc' },
              { id: 'asc' },
            ],
            take: POINTS_VIEW.lots,
          }),
          this.prisma.pointLedger.findMany({
            where: { wawuUserId },
            orderBy: { seq: 'desc' },
            take: POINTS_VIEW.movements,
            include: {
              lot: { select: { source: true } },
              hold: { select: { purpose: true, state: true, title: true } },
            },
          }),
        ],
        { isolationLevel: 'RepeatableRead' },
      );

    const soonest = soonestEnd[0];
    const nextExpiry = soonest
      ? {
          points: soonest._sum?.remaining ?? 0,
          expiresAt: soonest.expiresAt.toISOString(),
        }
      : null;

    const movements: PointMovementView[] = rows.map((row) => ({
      id: row.id,
      points: row.delta,
      label: pointMovementLabel({
        reason: row.reason,
        lotSource: row.lot.source,
        hold: row.hold,
      }),
      reason: row.reason,
      pending: row.reason === 'hold' && row.hold?.state === 'held',
      createdAt: row.at.toISOString(),
    }));

    return {
      balance: sum._sum.remaining ?? 0,
      nextExpiry,
      lots: lots.map((lot) => ({
        id: lot.id,
        points: lot.remaining,
        granted: lot.quantity,
        source: lot.source,
        label: POINT_LOT_LABELS[lot.source],
        expiresAt: lot.expiresAt.toISOString(),
      })),
      lotCount,
      movements,
    };
  }

  // ---------------------------------------------------------------------------

  private async settle(
    key: PointHoldKey,
    to: 'committed' | 'released',
    now: Date,
    outer: Tx | undefined,
  ): Promise<PointHoldOutcome> {
    return this.inTx(outer, async (tx) => {
      const found = await findHold(tx, key);
      if (!found) {
        throw new PointsError(
          'points_hold_not_found',
          "We couldn't find those held points.",
        );
      }
      // The hold's person never changes, so lock them and read it again.
      await lockPersonPoints(tx, found.wawuUserId);
      const hold = await tx.pointHold.findUniqueOrThrow({
        where: { id: found.id },
      });
      if (hold.state === to) return outcomeOf(tx, hold, true);
      if (hold.state !== 'held') {
        throw new PointsError(
          'points_hold_settled',
          hold.state === 'committed'
            ? 'Those points were already spent.'
            : 'Those points were already given back.',
        );
      }

      if (to === 'released') {
        for (const part of await partsOf(tx, hold.id)) {
          const lot = await tx.pointLot.findUniqueOrThrow({
            where: { id: part.lotId },
          });
          await giveBackToLot(tx, lot.id, part.points);
          await tx.pointLedger.create({
            data: {
              wawuUserId: hold.wawuUserId,
              lotId: lot.id,
              delta: part.points,
              reason: 'release',
              holdId: hold.id,
              reference: hold.reference,
            },
          });
          if (lot.expiresAt <= now) {
            // The lot's first lapse time stands.
            await takeFromLot(tx, lot.id, part.points, lot.lapsedAt ?? now);
            await tx.pointLedger.create({
              data: {
                wawuUserId: hold.wawuUserId,
                lotId: lot.id,
                delta: -part.points,
                reason: 'expire',
              },
            });
          }
        }
      }

      const { count } = await tx.pointHold.updateMany({
        where: { id: hold.id, state: 'held' },
        data: { state: to, settledAt: now },
      });
      if (count !== 1) {
        throw new Error(`points: hold ${hold.id} moved under its lock`);
      }
      return outcomeOf(tx, { ...hold, state: to }, false);
    });
  }

  private inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.prisma.$transaction(fn);
  }
}

// -----------------------------------------------------------------------------

/** Takes `points` from a lot, only if it still has them. */
async function takeFromLot(
  tx: Tx,
  lotId: string,
  points: number,
  lapsedAt?: Date,
): Promise<void> {
  const { count } = await tx.pointLot.updateMany({
    where: { id: lotId, remaining: { gte: points } },
    data: {
      remaining: { decrement: points },
      ...(lapsedAt ? { lapsedAt } : {}),
    },
  });
  if (count !== 1) {
    throw new Error(`points: lot ${lotId} no longer holds ${points} points`);
  }
}

/** Puts `points` back into the lot they were held from. */
async function giveBackToLot(
  tx: Tx,
  lotId: string,
  points: number,
): Promise<void> {
  const { count } = await tx.pointLot.updateMany({
    where: { id: lotId },
    data: { remaining: { increment: points } },
  });
  if (count !== 1) {
    throw new Error(`points: lot ${lotId} is gone`);
  }
}

/** The lots a hold took from, and how many from each, from its ledger rows. */
async function partsOf(
  tx: Tx,
  holdId: string,
): Promise<Array<{ lotId: string; points: number }>> {
  const rows = await tx.pointLedger.findMany({
    where: { holdId, reason: 'hold' },
    select: { lotId: true, delta: true },
    orderBy: { seq: 'asc' },
  });
  return rows.map((r) => ({ lotId: r.lotId, points: -r.delta }));
}

async function findHold(
  tx: Tx,
  key: PointHoldKey,
): Promise<{ id: string; wawuUserId: string } | null> {
  if ('holdId' in key) {
    return tx.pointHold.findUnique({
      where: { id: key.holdId },
      select: { id: true, wawuUserId: true },
    });
  }
  return tx.pointHold.findUnique({
    where: {
      purpose_reference: { purpose: key.purpose, reference: key.reference },
    },
    select: { id: true, wawuUserId: true },
  });
}

async function outcomeOf(
  tx: Tx,
  hold: {
    id: string;
    wawuUserId: string;
    state: PointHoldState;
    quantity: number;
  },
  replayed: boolean,
): Promise<PointHoldOutcome> {
  return {
    holdId: hold.id,
    wawuUserId: hold.wawuUserId,
    state: hold.state,
    points: hold.quantity,
    parts: await partsOf(tx, hold.id),
    replayed,
  };
}

function requirePerson(wawuUserId: string): void {
  if (typeof wawuUserId !== 'string' || wawuUserId.length === 0) {
    throw new PointsError('points_invalid', 'Points need a person.');
  }
}

function requireReference(reference: string): void {
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    reference.length > POINTS_LIMITS.referenceLength
  ) {
    throw new PointsError('points_invalid', 'Points need a reference.');
  }
}

function requirePoints(points: number): void {
  if (
    !Number.isSafeInteger(points) ||
    points <= 0 ||
    points > POINTS_LIMITS.maxPoints
  ) {
    throw new PointsError(
      'points_invalid',
      'Points must be a whole number above zero.',
    );
  }
}
