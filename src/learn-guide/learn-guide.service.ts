import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { LearnGuideResponse, LearnGuideSection } from '../common/types';
import type { LearnGuideModel } from '../../generated/prisma/models';
import type { ListLearnGuidesQueryDto } from './dto/list-learn-guides-query.dto';

/** Registry: GET /learn/guides -> LearnGuide[], GET /learn/guides/:id -> LearnGuide. Both roles: ["any"]. */
@Injectable()
export class LearnGuideService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListLearnGuidesQueryDto): Promise<LearnGuideResponse[]> {
    const guides = await this.prisma.learnGuide.findMany({
      where: {
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.country ? { country: query.country } : {}),
      },
      orderBy: { updated: 'desc' },
    });
    return guides.map(toResponse);
  }

  async findOne(id: string): Promise<LearnGuideResponse | null> {
    const guide = await this.prisma.learnGuide.findUnique({ where: { id } });
    return guide ? toResponse(guide) : null;
  }
}

function toResponse(guide: LearnGuideModel): LearnGuideResponse {
  return { ...guide, sections: (guide.sections as unknown as LearnGuideSection[] | null) ?? null };
}
