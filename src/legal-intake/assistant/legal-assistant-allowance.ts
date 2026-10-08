import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR,
  ASSISTANT_CLAIM_MS,
  ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
  ASSISTANT_CLIENT_MESSAGES_PER_INTAKE,
  ASSISTANT_OPENER_ATTEMPTS_PER_HOUR,
} from './legal-assistant-config';

export const ONE_HOUR_MS = 3_600_000;

/** The interactive transactions below are short; this only covers a queue. */
export const TX_OPTIONS = { maxWait: 15_000, timeout: 15_000 };

/**
 * What a limit check is for (see `reserve`). A client message on a matter
 * thread is reserved through `reserveMatterMessage`, which also decides
 * whether the message is counted at all.
 */
export type Spend = 'message' | 'reply' | 'brief';

/**
 * What `reserveOpener` found: this caller makes the opener's call (`claimed`,
 * with the call's row id), the thread already has a line (`opened`), or
 * another read is making the call right now (`busy`).
 */
export type OpenerClaim =
  { kind: 'claimed'; callId: string } | { kind: 'opened' } | { kind: 'busy' };

/** How an opener call ended (`LegalChatOpenerCall.outcome`). */
export type OpenerOutcome = 'written' | 'failed' | 'superseded';

/**
 * Has a consultant written anywhere in this matter's thread? ONE question,
 * asked of the whole thread, by both sides of the handover: the reservation
 * (is this client message counted?) and the assistant (does it answer?). If
 * they ever asked it differently (a window of rows, a different query) a
 * message could be free for one and answered by the other, an uncounted AI
 * call (LEGAL-01, D9). `db` is the transaction or the client.
 */
export async function consultantHasWritten(
  db: Pick<Prisma.TransactionClient, 'legalChatMessage'>,
  requestId: string,
): Promise<boolean> {
  const row = await db.legalChatMessage.findFirst({
    where: { legalRequestId: requestId, authorRole: 'consultant' },
    select: { id: true },
  });
  return row !== null;
}

/** Does the matter's thread have any line at all? */
async function threadHasLine(
  db: Pick<Prisma.TransactionClient, 'legalChatMessage'>,
  requestId: string,
): Promise<boolean> {
  const row = await db.legalChatMessage.findFirst({
    where: { legalRequestId: requestId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Is an opener call running for this thread right now: claimed, not ended,
 * and its claim not lapsed? `db` is the transaction or the client.
 */
export async function openerRunning(
  db: Pick<Prisma.TransactionClient, 'legalChatOpenerCall'>,
  requestId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await db.legalChatOpenerCall.findFirst({
    where: { legalRequestId: requestId, outcome: null, busyUntil: { gt: now } },
    select: { id: true },
  });
  return row !== null;
}

/** A refusal the app can switch on (`reason.code`), never a bare sentence. */
export function refusal(
  status: HttpStatus,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const body = { message, reason: { code, message, ...extra } };
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return new BadRequestException(body);
    case HttpStatus.NOT_FOUND:
      return new NotFoundException(body);
    case HttpStatus.CONFLICT:
      return new ConflictException(body);
    case HttpStatus.SERVICE_UNAVAILABLE:
      return new ServiceUnavailableException(body);
    default:
      return new HttpException(body, status);
  }
}

/**
 * One allowance per person for everything in the legal chat that spends an
 * AI call (LEGAL-01). The assistant routes and the older matter-chat route
 * (`POST /legal/intake/chat/{requestId}`) both reserve through here, so a
 * client who mixes them still has ONE hourly allowance, not one per route.
 * So does the opener a first read of a paid matter's thread writes
 * (`GET /legal/intake/chat/{requestId}`, FIX-11): reading is not free of
 * paid calls just because nobody typed.
 */
@Injectable()
export class LegalAssistantAllowance {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Serializes everything that spends a person's allowance. Held to the end
   * of the transaction, so a check and the write it allows are one step.
   */
  async lockPerson(
    tx: Prisma.TransactionClient,
    wawuUserId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`legal-assistant:${wawuUserId}`}, 0))`;
  }

  /**
   * Check the limits and write what they allow in ONE transaction under the
   * person's lock. The count of what is already spent and the write that
   * spends one more cannot be pulled apart by a parallel request, so the
   * limits hold however many arrive at once. The provider is called after
   * this returns, never inside it.
   *
   * What counts: a client message, a reply asked for again and a brief
   * prepared (`LegalAssistantCall`), a client message written after Send,
   * and every call that tried to write a matter thread's opener
   * (`LegalChatOpenerCall`, FIX-11).
   */
  async reserve<T>(
    wawuUserId: string,
    intakeId: string | null,
    spend: Spend,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPerson(tx, wawuUserId);
      await this.checkLimits(tx, wawuUserId, intakeId, spend);
      return write(tx);
    }, TX_OPTIONS);
  }

  /**
   * A client message on a matter thread (`POST /legal/intake/chat/{requestId}`
   * and `POST /legal/assistant/{id}/messages` after Send), written in the same
   * step as its check, under the person's lock.
   *
   * Once a consultant has written in the thread, the assistant never answers
   * there again (`LegalChatService.answerWaiting`), so the client's later
   * messages spend no AI call: they are not counted and never refused. That
   * is decided HERE, inside the lock and the transaction, from the rows the
   * transaction can see. A consultant's line is permanent once it is there,
   * so a message that is let through free can never be one the assistant
   * answers, and a message sent before the consultant wrote is counted as
   * usual. A consultant who writes a moment after the check changes nothing
   * for this message: it was counted, and the assistant stands down on its
   * own check afterwards.
   *
   * The row is stamped with the time taken after the lock is held, so a
   * message written after the consultant's line is later than it however
   * long the request waited for the lock (the hourly count in `checkLimits`
   * tells the two kinds apart by that order).
   */
  async reserveMatterMessage<T>(
    wawuUserId: string,
    requestId: string,
    write: (tx: Prisma.TransactionClient, createdAt: Date) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPerson(tx, wawuUserId);
      if (!(await consultantHasWritten(tx, requestId))) {
        await this.checkLimits(tx, wawuUserId, null, 'matter_message');
      }
      return write(tx, new Date());
    }, TX_OPTIONS);
  }

  /**
   * Claim the ONE paid AI call that writes a matter thread's opener (FIX-11).
   *
   * Under the person's lock, in one step: if the thread has any line it is
   * already open; if another opener call for it is running (its claim has
   * not lapsed) this caller waits for that one; otherwise the hourly limits
   * are checked and the call is written down (`LegalChatOpenerCall`), which
   * both counts it and holds the claim. The provider is called after this
   * returns, never inside it. Over a limit this throws the same 429
   * `assistant_rate_limited` a message gets, and no call is made.
   *
   * Every thread line is written under this same lock (client messages in
   * `reserveMatterMessage`, a consultant's in `writeAsConsultant`, the opener
   * in `finishOpener`), so "is the thread empty" cannot change while it is
   * being decided.
   */
  async reserveOpener(
    wawuUserId: string,
    requestId: string,
  ): Promise<OpenerClaim> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPerson(tx, wawuUserId);
      if (await threadHasLine(tx, requestId)) return { kind: 'opened' };
      const now = new Date();
      if (await openerRunning(tx, requestId, now)) return { kind: 'busy' };
      await this.checkLimits(tx, wawuUserId, null, 'opener');
      const call = await tx.legalChatOpenerCall.create({
        data: {
          legalRequestId: requestId,
          wawuUserId,
          busyUntil: new Date(now.getTime() + ASSISTANT_CLAIM_MS),
          createdAt: now,
        },
        select: { id: true },
      });
      return { kind: 'claimed', callId: call.id };
    }, TX_OPTIONS);
  }

  /**
   * End the opener call `reserveOpener` claimed: write the opener (when the
   * provider answered and the thread is still empty) and record how the call
   * ended, in one step under the person's lock. A thread that gained a line
   * while the call ran (the client wrote first, or a consultant did) keeps
   * it: the opener is not stored after it (`superseded`). The call stays
   * counted whatever the outcome; it was made. `write` is null when the
   * provider failed or answered nothing (`failed`), which also frees the
   * thread for the next read to try again.
   */
  async finishOpener(
    wawuUserId: string,
    requestId: string,
    callId: string,
    write:
      | ((tx: Prisma.TransactionClient, createdAt: Date) => Promise<unknown>)
      | null,
  ): Promise<OpenerOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPerson(tx, wawuUserId);
      let outcome: OpenerOutcome = 'failed';
      if (write) {
        if (await threadHasLine(tx, requestId)) {
          outcome = 'superseded';
        } else {
          await write(tx, new Date());
          outcome = 'written';
        }
      }
      // After the opener's own write, in the same transaction: the partial
      // unique index refuses a second `written` row for the thread, and the
      // opener goes with it.
      await tx.legalChatOpenerCall.update({
        where: { id: callId },
        data: { outcome, busyUntil: null },
      });
      return outcome;
    }, TX_OPTIONS);
  }

  /**
   * A consultant's line in a matter thread, written under the client's lock.
   * `reserveMatterMessage` decides "has a consultant written" and counts the
   * hour by the ORDER of stamps, so the consultant's line takes the same lock
   * and its stamp after it: every client message is then either entirely
   * before it (counted, and the assistant may have answered) or entirely
   * after it (free), never half of each, and no client message can slip past
   * the limit by racing the handover. It waits only for the client's own
   * messages in flight, each a short step.
   */
  async writeAsConsultant<T>(
    clientWawuUserId: string,
    write: (tx: Prisma.TransactionClient, createdAt: Date) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPerson(tx, clientWawuUserId);
      return write(tx, new Date());
    }, TX_OPTIONS);
  }

  private async checkLimits(
    tx: Prisma.TransactionClient,
    wawuUserId: string,
    intakeId: string | null,
    spend: Spend | 'matter_message' | 'opener',
  ) {
    if (intakeId && (spend === 'message' || spend === 'reply')) {
      const [messages, calls] = await Promise.all([
        tx.legalIntakeMessage.count({
          where: { legalIntakeId: intakeId, authorRole: 'client' },
        }),
        tx.legalAssistantCall.count({ where: { legalIntakeId: intakeId } }),
      ]);
      if (messages + calls >= ASSISTANT_CLIENT_MESSAGES_PER_INTAKE) {
        throw refusal(
          HttpStatus.CONFLICT,
          'assistant_conversation_full',
          'This conversation is long enough for a consultant to pick up. Send your brief to a consultant.',
        );
      }
    }

    const since = new Date(Date.now() - ONE_HOUR_MS);
    const requestIds = (
      await tx.legalRequest.findMany({
        where: { wawuUserId },
        select: { id: true },
      })
    ).map((r) => r.id);
    const [clientRows, callRows, openerRows, matterRows] = await Promise.all([
      tx.legalIntakeMessage.findMany({
        where: { wawuUserId, authorRole: 'client', createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      tx.legalAssistantCall.findMany({
        where: { wawuUserId, createdAt: { gte: since } },
        select: { createdAt: true, kind: true },
      }),
      // The opener calls on matter threads (FIX-11), every attempt.
      tx.legalChatOpenerCall.findMany({
        where: { wawuUserId, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      requestIds.length === 0
        ? Promise.resolve(
            [] as Array<{ createdAt: Date; legalRequestId: string }>,
          )
        : tx.legalChatMessage.findMany({
            where: {
              legalRequestId: { in: requestIds },
              authorRole: 'client',
              createdAt: { gte: since },
            },
            select: { createdAt: true, legalRequestId: true },
          }),
    ]);

    // A client message written after a consultant had written in its thread
    // is for the consultant, spent no AI call and is not counted.
    const joinedAt = new Map<string, number>();
    if (matterRows.length > 0) {
      const joined = await tx.legalChatMessage.groupBy({
        by: ['legalRequestId'],
        where: {
          legalRequestId: { in: requestIds },
          authorRole: 'consultant',
        },
        _min: { createdAt: true },
      });
      for (const j of joined) {
        if (j._min.createdAt) {
          joinedAt.set(j.legalRequestId, j._min.createdAt.getTime());
        }
      }
    }
    const countedMatterRows = matterRows.filter((r) => {
      const at = joinedAt.get(r.legalRequestId);
      return !(at !== undefined && at < r.createdAt.getTime());
    });

    const stamps = [
      ...clientRows,
      ...callRows,
      ...openerRows,
      ...countedMatterRows,
    ]
      .map((r) => r.createdAt.getTime())
      .sort((a, b) => a - b);
    if (stamps.length >= ASSISTANT_CLIENT_MESSAGES_PER_HOUR) {
      throw this.rateLimited(
        stamps[stamps.length - ASSISTANT_CLIENT_MESSAGES_PER_HOUR],
        'You have sent a lot of messages in the last hour. Try again a little later.',
      );
    }

    if (spend === 'brief') {
      const briefs = callRows
        .filter((c) => c.kind === 'brief')
        .map((c) => c.createdAt.getTime())
        .sort((a, b) => a - b);
      if (briefs.length >= ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR) {
        throw this.rateLimited(
          briefs[briefs.length - ASSISTANT_BRIEF_ATTEMPTS_PER_HOUR],
          'The brief could not be prepared a few times just now. Try again a little later.',
        );
      }
    }

    if (spend === 'opener') {
      const openers = openerRows
        .map((c) => c.createdAt.getTime())
        .sort((a, b) => a - b);
      if (openers.length >= ASSISTANT_OPENER_ATTEMPTS_PER_HOUR) {
        throw this.rateLimited(
          openers[openers.length - ASSISTANT_OPENER_ATTEMPTS_PER_HOUR],
          'The assistant could not open this conversation a few times just now. Try again a little later.',
        );
      }
    }
  }

  private rateLimited(oldestCountedMs: number, message: string) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldestCountedMs + ONE_HOUR_MS - Date.now()) / 1000),
    );
    return refusal(
      HttpStatus.TOO_MANY_REQUESTS,
      'assistant_rate_limited',
      message,
      { retryAfterSeconds },
    );
  }
}
