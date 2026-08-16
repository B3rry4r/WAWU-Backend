import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { MentorRequest } from '../common/types';
import type { CreateMentorRequestDto } from './dto/create-mentor-request.dto';

/**
 * MentorRequest resource — registry.json "MentorRequest". FREE (mentors
 * volunteer their time, per product-truths.json / the schema agent's
 * comment on the Prisma model) — no payment step, unlike Purchase's
 * unlock flow. `status` defaults to "pending" per the Prisma schema; no
 * enumerated value set is given in the registry, so it is left as-is here.
 */
@Injectable()
export class MentorRequestService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMentorExists(mentorId: string): Promise<void> {
    const mentor = await this.prisma.mentor.findUnique({
      where: { id: mentorId },
      select: { id: true },
    });
    if (!mentor) {
      throw new NotFoundException('Mentor not found');
    }
  }

  async create(
    mentorId: string,
    requesterWawuId: string,
    dto: CreateMentorRequestDto,
  ): Promise<MentorRequest> {
    await this.assertMentorExists(mentorId);

    return this.prisma.mentorRequest.create({
      data: {
        mentorId,
        requesterWawuId,
        topics: dto.topics,
        note: dto.note,
        slot: dto.slot,
      },
    });
  }
}
