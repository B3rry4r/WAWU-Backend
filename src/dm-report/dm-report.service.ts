import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { DmReport } from '../common/types';

/**
 * Owns DmReport — the "report this DM thread" action off the messages-dm
 * screen (registry.json § DmReport). Frozen contract has a single write
 * path: create a report row for {threadId, reporterWawuId}. Reads /
 * moderation-queue listing are out of this resource's frozen contract (no
 * GET endpoint is declared), so this service is create-only.
 *
 * `@@unique([threadId, reporterWawuId])` on the Prisma model (schema
 * comment: "JUDGMENT: added ... not specified in registry, but a reporter
 * reporting the same thread twice is not a new report") means a second
 * report from the same reporter on the same thread is a conflict, not a
 * duplicate row — surfaced as 409, not silently accepted or 500'd.
 */
@Injectable()
export class DmReportService {
  constructor(private readonly prisma: PrismaService) {}

  async create(threadId: string, reporterWawuId: string): Promise<DmReport> {
    const thread = await this.prisma.directMessage.findUnique({
      where: { id: threadId },
      select: { id: true },
    });
    if (!thread) {
      throw new NotFoundException('DM thread not found');
    }

    try {
      return await this.prisma.dmReport.create({
        data: { threadId, reporterWawuId },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You have already reported this thread');
      }
      throw error;
    }
  }
}
