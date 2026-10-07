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

/** What a limit check is for (see `reserve`). */
export type Spend = 'message' | 'reply' | 'brief' | 'matter_message';

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

  private async checkLimits(
    tx: Prisma.TransactionClient,
    wawuUserId: string,
    intakeId: string | null,
    spend: Spend,
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
        ? Promise.resolve([] as Array<{ createdAt: Date }>)
        : tx.legalChatMessage.findMany({
            where: {
              legalRequestId: { in: requestIds },
              authorRole: 'client',
              createdAt: { gte: since },
            },
            select: { createdAt: true },
          }),
    ]);

    const stamps = [...clientRows, ...callRows, ...matterRows]
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
