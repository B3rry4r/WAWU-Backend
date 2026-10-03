import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import type { NotificationEvent } from '../notification/notification-event';
import {
  paidDmPauseConfig,
  type PaidDmPauseConfig,
} from './paid-dm-pause.config';
import type {
  PaidDmAvailability,
  PaidDmStanding,
  PaidDmStandingState,
} from './paid-dm-view.type';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The reason code a refused paid question carries (the app shows I8 on it). */
export const PAID_MESSAGES_PAUSED = 'paid_messages_paused';

interface Evaluated {
  state: PaidDmStandingState;
  pct: number;
  unanswered: number | null;
  questions: number | null;
  pausedUntil: Date | null;
}

/**
 * A creator's standing on unanswered paid questions (task INBOX-09, R-13).
 *
 * The rate is computed from the questions themselves every time, never from
 * a stored count, so it cannot drift: of the questions SENT inside the rolling
 * window whose outcome is known (answered, or past their deadline), the share
 * that went unanswered. A question still inside its window is undecided and
 * counts for nothing yet. "Past its deadline" uses the same strict test the
 * reply route and the sweep use (`deadlineAt < now`), so a question is
 * answerable or unanswered, never both, and does not wait for the sweep to
 * flip its status.
 *
 * The line is "at or over": 20% warns, 30% pauses. Compared in integers
 * (`unanswered * 100 >= pct * questions`), so no rounding decides a boundary.
 *
 * The stored row (CreatorNoResponseTracker) holds the state, not the facts:
 * `penaltyState`, the last share and `dmDisabledUntil`. Every transition runs
 * under a row lock, so two requests evaluating the same creator at the same
 * instant cannot both warn, or both start a pause: the second sees what the
 * first wrote. A pause is fixed: it is never extended by later evaluations,
 * and it ends by the clock alone (`dmDisabledUntil <= now` is open), with or
 * without the sweep. A pause that ended starts a fresh count: only questions
 * sent after it ended are taken into account, so the same old misses cannot
 * pause the creator again the moment they return.
 */
@Injectable()
export class PaidDmPauseService {
  private readonly logger = new Logger(PaidDmPauseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** The creator's own standing, evaluated now. */
  async standing(
    creatorWawuId: string,
    now: Date = new Date(),
  ): Promise<PaidDmStanding> {
    const cfg = paidDmPauseConfig();
    const { result } = await this.evaluate(creatorWawuId, now, cfg);
    return {
      state: result.state,
      acceptingPaidMessages: result.state !== 'paused',
      unansweredPct: result.pct,
      unanswered: result.unanswered,
      questions: result.questions,
      warnAtPct: cfg.warnAtPct,
      pauseAtPct: cfg.pauseAtPct,
      windowDays: cfg.windowDays,
      pauseDays: cfg.pauseDays,
      pausedUntil: result.pausedUntil ? result.pausedUntil.toISOString() : null,
    };
  }

  /** What a fan sees on a creator's profile. 404 for an account with no creator state. */
  async availability(
    creatorWawuId: string,
    now: Date = new Date(),
  ): Promise<PaidDmAvailability> {
    const creator = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { wawuUserId: true },
    });
    if (!creator) throw new NotFoundException('Creator not found');
    const { result } = await this.evaluate(
      creatorWawuId,
      now,
      paidDmPauseConfig(),
    );
    const paused = result.state === 'paused';
    return {
      creatorWawuId,
      paused,
      pausedUntil:
        paused && result.pausedUntil ? result.pausedUntil.toISOString() : null,
    };
  }

  /**
   * The gate a fan's new paid question passes before anything is charged.
   * Refuses with 403 and a `reason` the app reads (`paid_messages_paused`
   * and the time they come back).
   */
  async assertAccepting(
    creatorWawuId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const { result } = await this.evaluate(
      creatorWawuId,
      now,
      paidDmPauseConfig(),
    );
    if (result.state !== 'paused' || !result.pausedUntil) return;
    throw new ForbiddenException({
      message: 'This creator has switched off paid messages for now.',
      reason: {
        code: PAID_MESSAGES_PAUSED,
        message: 'This creator has switched off paid messages for now.',
        pausedUntil: result.pausedUntil.toISOString(),
      },
    });
  }

  /**
   * The sweep: creators with a miss in the window, and creators already
   * warned or paused (so a pause that ended, or a warning that cleared,
   * is written back without waiting for someone to look).
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const cfg = paidDmPauseConfig();
    const from = new Date(now.getTime() - cfg.windowDays * DAY_MS);
    const [missed, flagged] = await Promise.all([
      this.prisma.directMessage.findMany({
        where: {
          sentAt: { gte: from },
          OR: [
            { status: 'refunded' },
            { status: 'awaiting_response', deadlineAt: { lt: now } },
          ],
        },
        distinct: ['creatorWawuId'],
        select: { creatorWawuId: true },
        take: 500,
      }),
      this.prisma.creatorNoResponseTracker.findMany({
        where: { penaltyState: { not: 'none' } },
        select: { creatorWawuId: true },
        take: 500,
      }),
    ]);
    const ids = new Set([
      ...missed.map((m) => m.creatorWawuId),
      ...flagged.map((f) => f.creatorWawuId),
    ]);
    for (const id of ids) {
      try {
        await this.evaluate(id, now, cfg);
      } catch (error) {
        this.logger.error(
          `Paid-question standing failed for ${id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return ids.size;
  }

  // -- internals ------------------------------------------------------------

  private async evaluate(
    creatorWawuId: string,
    now: Date,
    cfg: PaidDmPauseConfig,
  ): Promise<{ result: Evaluated }> {
    const events: NotificationEvent[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      // The row has to exist to be locked. ON CONFLICT DO NOTHING, so two
      // first evaluations cannot collide.
      await tx.creatorNoResponseTracker.createMany({
        data: [{ creatorWawuId }],
        skipDuplicates: true,
      });
      const [row] = await tx.$queryRaw<
        {
          penaltyState: string;
          dmDisabledUntil: Date | null;
          noResponseRatePct: Prisma.Decimal;
        }[]
      >(Prisma.sql`
        SELECT "penaltyState"::text AS "penaltyState", "dmDisabledUntil", "noResponseRatePct"
        FROM "CreatorNoResponseTracker"
        WHERE "creatorWawuId" = ${creatorWawuId}
        FOR UPDATE`);

      const until = row.dmDisabledUntil;
      if (until && until.getTime() > now.getTime()) {
        // Paused. Fixed: nothing here moves the end.
        return {
          state: 'paused',
          pct: Number(row.noResponseRatePct),
          unanswered: null,
          questions: null,
          pausedUntil: until,
        } satisfies Evaluated;
      }

      // Not paused. A pause that ended opens a fresh count at its end.
      const windowStart = new Date(now.getTime() - cfg.windowDays * DAY_MS);
      const from =
        until && until.getTime() > windowStart.getTime() ? until : windowStart;
      const base: Prisma.DirectMessageWhereInput = {
        creatorWawuId,
        sentAt: { gte: from },
      };
      const missed: Prisma.DirectMessageWhereInput = {
        OR: [
          { status: 'refunded' },
          { status: 'awaiting_response', deadlineAt: { lt: now } },
        ],
      };
      const [unanswered, answered] = await Promise.all([
        tx.directMessage.count({ where: { AND: [base, missed] } }),
        tx.directMessage.count({ where: { ...base, status: 'responded' } }),
      ]);
      const questions = unanswered + answered;
      const counts = questions >= cfg.minQuestions;
      const over = (pct: number) =>
        counts && unanswered * 100 >= pct * questions;
      const pct =
        questions === 0
          ? 0
          : Math.round((unanswered * 10_000) / questions) / 100;

      let state: PaidDmStandingState = 'ok';
      let pausedUntil: Date | null = null;
      if (over(cfg.pauseAtPct)) {
        state = 'paused';
        pausedUntil = new Date(now.getTime() + cfg.pauseDays * DAY_MS);
        events.push({
          kind: 'paid_dm_paused',
          userWawuId: creatorWawuId,
          unansweredPct: pct,
          windowDays: cfg.windowDays,
          pauseDays: cfg.pauseDays,
          until: pausedUntil,
        });
      } else if (over(cfg.warnAtPct)) {
        state = 'warning';
        // Warned once per crossing: only the move into `warned` speaks.
        if (row.penaltyState !== 'warned') {
          events.push({
            kind: 'paid_dm_warning',
            userWawuId: creatorWawuId,
            unansweredPct: pct,
            windowDays: cfg.windowDays,
            pauseAtPct: cfg.pauseAtPct,
            pauseDays: cfg.pauseDays,
          });
        }
      }

      const nextPenalty =
        state === 'ok'
          ? 'none'
          : state === 'warning'
            ? 'warned'
            : 'disabled_7d';
      if (
        nextPenalty !== row.penaltyState ||
        Number(row.noResponseRatePct) !== pct ||
        pausedUntil !== null
      ) {
        await tx.creatorNoResponseTracker.update({
          where: { creatorWawuId },
          data: {
            penaltyState: nextPenalty,
            noResponseRatePct: pct,
            ...(pausedUntil ? { dmDisabledUntil: pausedUntil } : {}),
          },
        });
      }
      return {
        state,
        pct,
        unanswered,
        questions,
        pausedUntil,
      } satisfies Evaluated;
    });

    // After the commit, and only for the evaluation that made the move.
    for (const event of events) await this.notifications.emit(event);
    return { result };
  }
}
