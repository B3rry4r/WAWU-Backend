import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NuvionHandlerRegistry } from '../handlers/nuvion-handler-registry';
import type {
  NuvionDelivery,
  NuvionHandlerResult,
} from '../handlers/nuvion-handler.interface';

/** What one pass over one stored delivery did. */
export type NuvionDispatchOutcome =
  /** Every handler of its event is done with it. */
  | 'processed'
  /** A handler can never use it: kept for review, with a note. */
  | 'failed'
  /** A handler asked to wait: left pending, tried again later. */
  | 'waiting'
  /** Not pending, no handler for its event, or another worker holds it. */
  | 'skipped';

const MINUTE = 60_000;

/**
 * How the stored deliveries are handed to their handlers. Not a fee, a
 * limit or a promise: how many per pass, how long a worker holds one, and
 * how long a waiting one rests (1, 2, 4 ... minutes, at most an hour).
 */
export const NUVION_DISPATCH = {
  batch: 20,
  leaseMs: 5 * MINUTE,
  maxRestMs: 60 * MINUTE,
} as const;

/**
 * Hands Nuvion's stored deliveries to the handlers of their event (task
 * NUV-01): a sweep every 30 seconds over the `pending` rows of the events
 * some handler lists, oldest first, never on receipt (the receiver answers
 * once the row is stored, as Nuvion asks).
 *
 * One worker at a time per delivery: a conditional update claims it for
 * NUVION_DISPATCH.leaseMs, so two servers never run its handlers together;
 * a worker that dies leaves the claim to lapse. Then every handler of the
 * event runs in turn:
 * - all `done`: `processed`;
 * - any `wait` (or a handler that throws): left `pending`, resting on the
 *   row (`nextAttemptAt`), and every handler runs again next time, so
 *   handlers are idempotent;
 * - otherwise any `failed`: `failed`, for review.
 * A delivery whose event no handler lists stays `pending`, untouched, and
 * is handled once a task lists it. Nothing here moves money itself.
 */
@Injectable()
export class NuvionWebhookDispatcher {
  private readonly logger = new Logger(NuvionWebhookDispatcher.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: NuvionHandlerRegistry,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'nuvion-webhook-dispatch' })
  async sweep(
    now = new Date(),
  ): Promise<Record<NuvionDispatchOutcome, number>> {
    const counts: Record<NuvionDispatchOutcome, number> = {
      processed: 0,
      failed: 0,
      waiting: 0,
      skipped: 0,
    };
    const events = this.registry.events();
    if (this.sweeping || events.length === 0) return counts;
    this.sweeping = true;
    try {
      const due = await this.prisma.nuvionWebhookEvent.findMany({
        where: {
          processingStatus: 'pending',
          event: { in: events },
          AND: [
            { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
            { OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
          ],
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: NUVION_DISPATCH.batch,
        select: { id: true },
      });
      for (const { id } of due) counts[await this.dispatch(id, now)] += 1;
      if (counts.processed + counts.failed > 0) {
        this.logger.log(
          `nuvion webhooks: ${counts.processed} processed, ${counts.failed} failed, ${counts.waiting} waiting`,
        );
      }
      return counts;
    } finally {
      this.sweeping = false;
    }
  }

  /** One stored delivery, by its NuvionWebhookEvent id. */
  async dispatch(id: string, now = new Date()): Promise<NuvionDispatchOutcome> {
    const head = await this.prisma.nuvionWebhookEvent.findUnique({
      where: { id },
      select: { event: true, processingStatus: true },
    });
    if (!head || head.processingStatus !== 'pending') return 'skipped';
    const handlers = this.registry.handlersFor(head.event);
    if (handlers.length === 0) return 'skipped';

    const claimed = await this.prisma.nuvionWebhookEvent.updateMany({
      where: {
        id,
        processingStatus: 'pending',
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
      },
      data: {
        claimedUntil: new Date(now.getTime() + NUVION_DISPATCH.leaseMs),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return 'skipped';
    const row = await this.prisma.nuvionWebhookEvent.findUniqueOrThrow({
      where: { id },
    });
    const payload = row.payload as { data?: unknown } | null;
    const delivery: NuvionDelivery = {
      id: row.id,
      eventId: row.eventId,
      event: row.event,
      resourceId: row.resourceId,
      entityId: row.entityId,
      data: payload && typeof payload === 'object' ? payload.data : undefined,
      receivedAt: row.receivedAt,
      attempts: row.attempts,
    };

    const results: NuvionHandlerResult[] = [];
    for (const handler of handlers) {
      try {
        const r = await handler.handle(delivery);
        results.push({ ...r, note: `${handler.task}: ${r.note}` });
      } catch (e) {
        // The name only: a message can quote what the delivery carried.
        results.push({
          outcome: 'wait',
          note: `${handler.task}: stopped (${(e as Error).name ?? 'Error'})`,
        });
      }
    }
    const note = results
      .map((r) => r.note)
      .join('; ')
      .slice(0, 1000);
    if (results.some((r) => r.outcome === 'wait')) {
      const rest = Math.min(
        MINUTE * 2 ** Math.min(row.attempts - 1, 12),
        NUVION_DISPATCH.maxRestMs,
      );
      await this.prisma.nuvionWebhookEvent.updateMany({
        where: { id, processingStatus: 'pending' },
        data: {
          note,
          claimedUntil: null,
          nextAttemptAt: new Date(now.getTime() + rest),
        },
      });
      return 'waiting';
    }
    const status = results.some((r) => r.outcome === 'failed')
      ? 'failed'
      : 'processed';
    await this.prisma.nuvionWebhookEvent.updateMany({
      where: { id, processingStatus: 'pending' },
      data: {
        processingStatus: status,
        note,
        claimedUntil: null,
        processedAt: now,
      },
    });
    return status;
  }
}
