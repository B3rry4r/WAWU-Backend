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
  ASSISTANT_CLIENT_MESSAGES_PER_HOUR,
  ASSISTANT_CLIENT_MESSAGES_PER_INTAKE,
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
   * prepared (`LegalAssistantCall`), and a client message written after Send.
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
      const consultant = await tx.legalChatMessage.findFirst({
        where: { legalRequestId: requestId, authorRole: 'consultant' },
        select: { id: true },
      });
      if (!consultant) {
        await this.checkLimits(tx, wawuUserId, null, 'matter_message');
      }
      return write(tx, new Date());
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
    spend: Spend | 'matter_message',
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
    const [clientRows, callRows, matterRows] = await Promise.all([
      tx.legalIntakeMessage.findMany({
        where: { wawuUserId, authorRole: 'client', createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      tx.legalAssistantCall.findMany({
        where: { wawuUserId, createdAt: { gte: since } },
        select: { createdAt: true, kind: true },
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

    const stamps = [...clientRows, ...callRows, ...countedMatterRows]
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
