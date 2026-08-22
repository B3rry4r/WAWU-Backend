import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { LearnGuideResponse, LearnGuideSection } from '../common/types';
import type { LearnGuideModel } from '../../generated/prisma/models';
import type { GuideKind } from '../../generated/prisma/enums';
import type { ListLearnGuidesQueryDto } from './dto/list-learn-guides-query.dto';
import type { UpsertLearnGuideDto } from './dto/upsert-learn-guide.dto';

/** Registry: GET /learn/guides -> LearnGuide[], GET /learn/guides/:id -> LearnGuide. Both roles: ["any"]. */
@Injectable()
export class LearnGuideService {
  constructor(private readonly prisma: PrismaService) {}

  async createGuide(dto: UpsertLearnGuideDto) {
    return this.prisma.learnGuide.create({
      data: {
        title: dto.title ?? 'Untitled guide',
        subtitle: dto.subtitle ?? '',
        // `article` is the neutral default: a country guide needs a country
        // and a template needs a file, so neither can be assumed. The old
        // default was 'guide', which is not a value this column accepts.
        kind: dto.kind ?? ('article' satisfies GuideKind),
        country: dto.country ?? null,
        readMinutes: dto.readMinutes ?? 5,
        updated: dto.updated ? new Date(dto.updated) : new Date(),
        fileUrl: dto.fileUrl ?? null,
        updatedAt: new Date(),
      },
    });
  }

  async updateGuide(id: string, dto: UpsertLearnGuideDto) {
    return this.prisma.learnGuide.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.subtitle !== undefined && { subtitle: dto.subtitle }),
        ...(dto.kind !== undefined && { kind: dto.kind }),
        ...(dto.country !== undefined && { country: dto.country }),
        ...(dto.readMinutes !== undefined && { readMinutes: dto.readMinutes }),
        ...(dto.updated !== undefined && { updated: new Date(dto.updated) }),
        ...(dto.fileUrl !== undefined && { fileUrl: dto.fileUrl }),
        updatedAt: new Date(),
      },
    });
  }

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
