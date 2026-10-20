import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DirectMessageModel as DirectMessageRow,
  DmReplyModel as DmReply,
} from '../../generated/prisma/models';
import { PrismaService } from '../common/prisma/prisma.service';
import { DmAnsweredHooks } from './dm-answered-hooks';

/** `first`: the legacy route, which answers a question once. `any`: INBOX-08, which adds bubbles while the window is open. */
export type ReplyMode = 'first' | 'any';

export interface PostedReply {
  message: DirectMessageRow;
  reply: DmReply;
  /** True when this call stored nothing: the `Idempotency-Key` had already stored this reply. */
  replayed: boolean;
}

/** Prisma's unique-constraint refusal (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * The one place a creator's reply to a paid question is written, so the
 * legacy `POST /dm/:messageId/respond` and the new reply route cannot drift.
 *
 * The first reply flips `awaiting_response` to `responded` with a conditional
 * `updateMany` (status and deadline in the WHERE). Two replies racing for the
 * flip, or a reply racing the deadline sweep, are settled by the database:
 * exactly one write matches. The loser re-reads. On `first` mode it is
 * refused (409, as the route always did); on `any` mode it is simply a later
 * bubble, because the window is still open and the question is answered.
 *
 * AN OPTIONAL `Idempotency-Key` (INBOX-18 round 2, verifier F1). A phone that
 * sent a reply and never heard the answer sends it again, and two taps at
 * once do the same; without a key each was a new bubble. With a key, per
 * creator and key the bubble is stored ONCE, and a repeat answers with it
 * (`replayed: true`); nothing is stored or released again.
 *
 *  - The arbiter is a UNIQUE index, not a read followed by a write: the key's
 *    row (`DmReplyKey`, primary key creator + key) is inserted by the same
 *    nested create as the bubble, so two requests with one key at the same
 *    moment, on one server or two, cannot both get in. The second waits on
 *    the index until the first commits, is refused by it, rolls back whole,
 *    and answers with the first bubble. That is how a key still in flight is
 *    answered: with the reply it is making, never with a second one.
 *  - A cheap read before the transaction answers the ordinary (not racing)
 *    repeat. It is a shortcut only; the index decides a race.
 *  - The same key for another question or other words is not a repeat: 409
 *    `idempotency_key_reused`, nothing stored (docs/contract/CONVENTIONS.md
 *    section 4).
 *  - Without a key none of this runs and nothing changes.
 */
@Injectable()
export class DmReplyWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly answered: DmAnsweredHooks,
  ) {}

  async post(
    creatorWawuId: string,
    messageId: string,
    text: string,
    mode: ReplyMode,
    idempotencyKey?: string,
  ): Promise<PostedReply> {
    if (idempotencyKey) {
      const earlier = await this.earlierReply(creatorWawuId, idempotencyKey);
      if (earlier) return this.replayOf(earlier, messageId, text);
    }
    let posted: PostedReply;
    try {
      posted = await this.write(
        creatorWawuId,
        messageId,
        text,
        mode,
        idempotencyKey,
      );
    } catch (error) {
      // Two requests with one key at the same moment: the database let one
      // key row in and refused this one, and its transaction rolled back
      // whole. The first has committed by now (the index waits for it), so
      // its bubble is the answer.
      if (idempotencyKey && isUniqueViolation(error)) {
        const earlier = await this.earlierReply(creatorWawuId, idempotencyKey);
        if (earlier) return this.replayOf(earlier, messageId, text);
      }
      throw error;
    }
    // The answer is committed. A question paid from the wallet now has its
    // held price released to the creator (INBOX-17); a failure there never
    // undoes the answer, and the hold sweep asks again.
    if (posted.message.flutterwaveTxRef.startsWith('wallet:')) {
      await this.answered.afterAnswered({
        id: posted.message.id,
        flutterwaveTxRef: posted.message.flutterwaveTxRef,
      });
    }
    return posted;
  }

  /** The bubble (and its question) this creator already stored under this key, if any. */
  private async earlierReply(
    creatorWawuId: string,
    key: string,
  ): Promise<{ reply: DmReply; message: DirectMessageRow } | null> {
    const row = await this.prisma.dmReplyKey.findUnique({
      where: { creatorWawuId_key: { creatorWawuId, key } },
      include: { reply: { include: { message: true } } },
    });
    if (!row) return null;
    const { message, ...reply } = row.reply;
    return { reply, message };
  }

  /** A repeat answers with the first bubble; the same key for another question or other words is refused. */
  private replayOf(
    earlier: { reply: DmReply; message: DirectMessageRow },
    messageId: string,
    text: string,
  ): PostedReply {
    if (earlier.reply.messageId !== messageId || earlier.reply.text !== text) {
      throw new ConflictException({
        message:
          'That Idempotency-Key was already used for a different reply. Send this one with a new key.',
        reason: 'idempotency_key_reused',
      });
    }
    return { ...earlier, replayed: true };
  }

  private async write(
    creatorWawuId: string,
    messageId: string,
    text: string,
    mode: ReplyMode,
    idempotencyKey?: string,
  ): Promise<PostedReply> {
    return this.prisma.$transaction(async (tx) => {
      const dm = await tx.directMessage.findUnique({
        where: { id: messageId },
      });
      if (!dm) throw new NotFoundException('Direct message not found');
      if (dm.creatorWawuId !== creatorWawuId) {
        throw new ForbiddenException(
          'You are not the creator this direct message was sent to.',
        );
      }
      const now = new Date();
      const windowPassed = () =>
        new ConflictException(
          `The ${dm.responseWindowHours}-hour response window for this direct message has passed.`,
        );
      const alreadyAnswered = (status: string) =>
        new ConflictException(
          `This direct message is already ${status} and cannot be responded to.`,
        );

      let message = dm;
      if (dm.status === 'awaiting_response') {
        if (dm.deadlineAt.getTime() < now.getTime()) throw windowPassed();
        const claim = await tx.directMessage.updateMany({
          where: {
            id: messageId,
            status: 'awaiting_response',
            deadlineAt: { gte: now },
          },
          data: { status: 'responded', respondedAt: now, responseText: text },
        });
        if (claim.count === 1) {
          message = await tx.directMessage.findUniqueOrThrow({
            where: { id: messageId },
          });
        } else {
          // Lost the flip to a concurrent reply or to the sweep.
          const fresh = await tx.directMessage.findUniqueOrThrow({
            where: { id: messageId },
          });
          if (fresh.status !== 'responded' || mode === 'first') {
            throw alreadyAnswered(fresh.status);
          }
          if (fresh.deadlineAt.getTime() < now.getTime()) throw windowPassed();
          message = fresh;
        }
      } else if (dm.status === 'responded') {
        if (mode === 'first') throw alreadyAnswered(dm.status);
        if (dm.deadlineAt.getTime() < now.getTime()) throw windowPassed();
      } else {
        throw alreadyAnswered(dm.status);
      }

      // The key's row goes in with the bubble, by the same nested create.
      const reply = await tx.dmReply.create({
        data: {
          messageId,
          creatorWawuId,
          text,
          idempotencyKey: idempotencyKey
            ? { create: { creatorWawuId, key: idempotencyKey } }
            : undefined,
        },
      });
      return { message, reply, replayed: false };
    });
  }
}
