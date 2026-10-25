import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  lagosDayStart,
  lagosNextDayStart,
} from '../../money/limits/lagos-window';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';
import { PointsError } from '../points-error';
import { lockPersonPoints } from '../points-lock';
import { PointsService, type PointHoldOutcome } from '../points.service';
import {
  capError,
  capStop,
  priceJob,
  type PricedJob,
  type SpendRequest,
} from './points-spend-rules';
import type {
  PointsCapView,
  PointsSettingsView,
} from './points-spend-view.type';

type Db = Prisma.TransactionClient | PrismaService;

/** A job asking for points. */
export interface SpendHoldInput extends SpendRequest {
  wawuUserId: string;
  /**
   * This ATTEMPT's own reference: the job's id and the try's number
   * (`jobHoldReference`). One reference holds once; asked again it answers
   * the hold in the state it is in, released included, so a retry after a
   * failed job needs a new reference.
   */
  reference: string;
}

/** The hold a job took, for the code that runs it. */
export interface SpendHoldOutcome {
  holdId: string;
  /** Always `held`: a hold that was spent or given back is refused, never returned. */
  state: 'held';
  costPoints: number;
  parts: PointHoldOutcome['parts'];
  /** True when this attempt's hold already existed and nothing was taken again. */
  replayed: boolean;
}

/** What a job would need, and what stands in its way, as of now. */
export interface SpendAssessment {
  job: PricedJob;
  balancePoints: number;
  shortfallPoints: number;
  spentTodayPoints: number;
  cap: PointsCapView | null;
  resetsAt: Date;
}

export const HOLD_ALREADY_USED_MESSAGE =
  'Those points were already used or given back for an earlier try. Start the job again to hold new points.';

/** The reference for try number `attempt` of a job: a new one for every attempt. */
export function jobHoldReference(jobId: string, attempt: number): string {
  return `${jobId}:${attempt}`;
}

/**
 * Spend points on the AI tools (task POINTS-03, R-43, PT1 to PT3 and PT7).
 *
 * The AI tools' server code (the tasks cut from the PT and VF boards) calls
 * `hold` before it asks a provider, `commit` when the job worked and
 * `release` when it did not. This service never calls a provider and never
 * touches money: a person who is short of points is not given any here; the
 * wallet shortfall is bought by `PointsShortfallService`, only after they
 * confirm with the PIN ("Without confirm, do nothing").
 *
 * - **Every cost and cap is a setting** (R-65): the job's points, the day's
 *   cap and the per-job caps are read from the live plan on each call.
 * - **A hold takes the cost, last.** The job's caps, the day's count and the
 *   hold are all under the person's points lock, in ONE database-only
 *   transaction, and the hold is its last write (lead note, 8 Oct): two jobs
 *   at once never pass the daily cap together and never take the balance
 *   below zero. Nothing here waits on a provider, so no lock is held across a
 *   network call; the caller must not hold one either.
 * - **A cap names itself.** `points_cap_reached` says which cap, its size
 *   and, for the day's, when the count starts again (midnight in Lagos).
 * - **A fresh reference for each attempt.** A reference that was spent or
 *   given back is `points_hold_settled`; it never returns a hold that has
 *   nothing in it to run on.
 */
@Injectable()
export class PointsSpendService {
  private readonly logger = new Logger(PointsSpendService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly points: PointsService,
  ) {}

  /**
   * What a job costs and what stands in its way, with nothing held. A read:
   * a hold that follows takes the lock and checks again.
   */
  async assess(
    wawuUserId: string,
    req: SpendRequest,
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<SpendAssessment> {
    // One reading of the plan, so the cost and the caps agree.
    const plan = this.config;
    const job = priceJob(plan, req);
    const [balancePoints, spentTodayPoints] = await Promise.all([
      this.points.balanceOf(wawuUserId, now),
      spentToday(db, wawuUserId, now),
    ]);
    const resetsAt = lagosNextDayStart(now);
    return {
      job,
      balancePoints,
      shortfallPoints: Math.max(0, job.costPoints - balancePoints),
      spentTodayPoints,
      cap: capStop(plan.caps, job, spentTodayPoints, resetsAt),
      resetsAt,
    };
  }

  /**
   * Takes the job's points, once per reference. Refuses with `points_cap_reached`
   * (a cap), `insufficient_points` (402, with the shortfall) or
   * `points_hold_settled` (this reference was already spent or given back);
   * nothing is held when it refuses.
   */
  async hold(
    input: SpendHoldInput,
    opts: { now?: Date } = {},
  ): Promise<SpendHoldOutcome> {
    const now = opts.now ?? new Date();
    // Priced from the live plan before the lock: a bad job is refused without
    // taking it.
    const plan = this.config;
    const job = priceJob(plan, input);
    return this.prisma.$transaction(async (tx) => {
      await lockPersonPoints(tx, input.wawuUserId);
      const known = await tx.pointHold.findUnique({
        where: {
          purpose_reference: {
            purpose: 'ai_job',
            reference: input.reference,
          },
        },
        select: { id: true },
      });
      if (!known) {
        // The caps stand in the way of a NEW hold only: an attempt that is
        // already holding its points has been counted.
        const stop = capStop(
          plan.caps,
          job,
          await spentToday(tx, input.wawuUserId, now),
          lagosNextDayStart(now),
        );
        if (stop) throw capError(stop);
      }
      // The hold is the last write of the transaction.
      const held = await this.points.hold(
        {
          wawuUserId: input.wawuUserId,
          purpose: 'ai_job',
          reference: input.reference,
          points: job.costPoints,
          title: job.title,
        },
        { tx, now },
      );
      if (held.state !== 'held')
        throw new PointsError('points_hold_settled', HOLD_ALREADY_USED_MESSAGE);
      return {
        holdId: held.holdId,
        state: 'held' as const,
        costPoints: held.points,
        parts: held.parts,
        replayed: held.replayed,
      };
    });
  }

  /** The job worked: the held points are spent. Again changes nothing; a given-back hold is `points_hold_settled`. */
  async commit(holdId: string): Promise<PointHoldOutcome> {
    await this.requireAiHold(holdId);
    return this.points.commit({ holdId });
  }

  /**
   * The job did not work: every held point goes back. Again changes nothing; a
   * spent hold is `points_hold_settled`. With `tx`, the points go back inside
   * the caller's transaction, so the job can end in the same commit.
   */
  async release(
    holdId: string,
    opts: { tx?: Prisma.TransactionClient } = {},
  ): Promise<PointHoldOutcome> {
    await this.requireAiHold(holdId, opts.tx);
    return this.points.release({ holdId }, opts);
  }

  /**
   * The sweep for AI holds that stayed `held` past the longest a job may run
   * (`points.job_max_run_minutes`, a setting): each is given back, by its id.
   * A job that commits late and the sweep cannot both win: whichever comes
   * second is refused by the points service (`points_hold_settled`) and that
   * is not an error here. At most `limit` holds a pass, oldest first.
   *
   * `longer` (AITOOLS-05): a tool that legitimately runs longer than the rest
   * has its own longest run. A `working` job of that action keeps its hold
   * until it is that old (counted as skipped, and it takes a place in the
   * page); past it the hold is swept like any other.
   */
  async releaseStale(
    maxRunMinutes: number,
    now: Date = new Date(),
    limit = 200,
    longer: readonly { action: string; maxRunMinutes: number }[] = [],
  ): Promise<{ released: number; skipped: number; failed: number }> {
    const cutoff = new Date(now.getTime() - maxRunMinutes * 60_000);
    const due = await this.prisma.pointHold.findMany({
      where: { purpose: 'ai_job', state: 'held', createdAt: { lt: cutoff } },
      select: { id: true, wawuUserId: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const out = { released: 0, skipped: 0, failed: 0 };
    for (const { id, wawuUserId } of due) {
      try {
        const done = await this.releaseUnlessWaiting(
          id,
          wawuUserId,
          now,
          longer,
        );
        // A dub still inside its own longest run keeps its hold.
        if (done === null || done.replayed) out.skipped += 1;
        else out.released += 1;
      } catch (e) {
        if (
          e instanceof PointsError &&
          (e.code === 'points_hold_settled' ||
            e.code === 'points_hold_not_found')
        ) {
          // The job committed after all, or the person was deleted.
          out.skipped += 1;
          continue;
        }
        out.failed += 1;
        this.logger.error(
          `points sweep: hold ${id} was not given back (${(e as Error).name ?? 'Error'})`,
        );
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // The person's choice: "Use wallet" (PT3)
  // -------------------------------------------------------------------------

  async useWalletOf(wawuUserId: string): Promise<boolean> {
    const row = await this.prisma.pointsSetting.findUnique({
      where: { wawuUserId },
      select: { useWallet: true },
    });
    return row?.useWallet ?? false;
  }

  async setUseWallet(
    wawuUserId: string,
    useWallet: boolean,
  ): Promise<PointsSettingsView> {
    const row = await this.prisma.pointsSetting.upsert({
      where: { wawuUserId },
      create: { wawuUserId, useWallet },
      update: { useWallet },
      select: { useWallet: true },
    });
    return { useWallet: row.useWallet };
  }

  // -------------------------------------------------------------------------

  /**
   * One stale hold given back, or `null` when it belongs to a `working` job of
   * a slower tool that is not yet as old as that tool's own longest run.
   *
   * An ordinary hold is released exactly as before AITOOLS-05: nothing is read
   * ahead of it. The wait is looked up only for a sweep that has slower tools,
   * inside the release's own transaction and under the person's lock, so it
   * costs the sweep no round trip before it takes the lock. (A first read of
   * the working jobs, ahead of the holds, put every release a round trip later
   * and the sweep lost, every time, the race against a job that commits late:
   * the POINTS-03 contract test saw a person's points pinned.)
   */
  private async releaseUnlessWaiting(
    holdId: string,
    wawuUserId: string,
    now: Date,
    longer: readonly { action: string; maxRunMinutes: number }[],
  ): Promise<PointHoldOutcome | null> {
    if (longer.length === 0) return this.points.release({ holdId }, { now });
    return this.prisma.$transaction(async (tx) => {
      await lockPersonPoints(tx, wawuUserId);
      const waiting = await tx.aiToolJob.findFirst({
        where: {
          holdId,
          state: 'working',
          OR: longer.map((l) => ({
            tool: l.action,
            createdAt: {
              gte: new Date(now.getTime() - l.maxRunMinutes * 60_000),
            },
          })),
        },
        select: { id: true },
      });
      if (waiting) return null;
      return this.points.release({ holdId }, { now, tx });
    });
  }

  /** An AI job's hold, or the same answer as one that never existed (a conversion's hold is not this service's). */
  private async requireAiHold(
    holdId: string,
    db: Db = this.prisma,
  ): Promise<void> {
    const hold = await db.pointHold.findUnique({
      where: { id: holdId },
      select: { purpose: true },
    });
    if (!hold || hold.purpose !== 'ai_job')
      throw new PointsError(
        'points_hold_not_found',
        "We couldn't find those held points.",
      );
  }
}

/**
 * Points of the person's AI jobs held or spent since the Lagos day began. A
 * job given back does not count. Counted by when the hold was made.
 */
async function spentToday(
  db: Db,
  wawuUserId: string,
  now: Date,
): Promise<number> {
  const sum = await db.pointHold.aggregate({
    where: {
      wawuUserId,
      purpose: 'ai_job',
      state: { in: ['held', 'committed'] },
      createdAt: { gte: lagosDayStart(now) },
    },
    _sum: { quantity: true },
  });
  return sum._sum.quantity ?? 0;
}
