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

/** `first`: the legacy route, which answers a question once. `any`: INBOX-08, which adds bubbles while the window is open. */
export type ReplyMode = 'first' | 'any';

export interface PostedReply {
  message: DirectMessageRow;
  reply: DmReply;
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
 */
@Injectable()
export class DmReplyWriter {
  constructor(private readonly prisma: PrismaService) {}

  async post(
    creatorWawuId: string,
    messageId: string,
    text: string,
    mode: ReplyMode,
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

      const reply = await tx.dmReply.create({
        data: { messageId, creatorWawuId, text },
      });
      return { message, reply };
    });
  }
}
