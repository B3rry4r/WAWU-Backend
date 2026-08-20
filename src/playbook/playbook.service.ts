import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type {
  PlaybookChapter,
  PlaybookReadingSection,
  PlaybookResponse,
} from '../common/types';

/**
 * Registry contract (registry.json § Playbook): a single GET endpoint,
 * `GET /learn/playbook`, roles: ["any"] (any authenticated WAWU user, per
 * conventions.md's "any authenticated user" guard idiom).
 *
 * There is exactly one Playbook row in this build (the free WAWU Business
 * Playbook, source screen "learn" — docs/01_SPEC.md "Free business
 * playbook (static resource)"). No create/update/delete endpoint is in the
 * contract, so this service is read-only.
 */
@Injectable()
export class PlaybookService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replaces the playbook's copy and/or its file.
   *
   * Upserts because the row may not exist yet on a fresh environment: an
   * operator uploading the playbook for the first time should not have to seed
   * a placeholder first.
   */
  async updatePlaybook(dto: {
    title?: string;
    description?: string;
    pages?: number;
    format?: string;
    fileUrl?: string;
  }) {
    const existing = await this.prisma.playbook.findFirst({ orderBy: { id: 'asc' } });
    const data = {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.pages !== undefined && { pages: dto.pages }),
      ...(dto.format !== undefined && { format: dto.format }),
      ...(dto.fileUrl !== undefined && { fileUrl: dto.fileUrl }),
      updatedAt: new Date(),
    };

    if (existing) {
      return this.prisma.playbook.update({ where: { id: existing.id }, data });
    }
    return this.prisma.playbook.create({
      data: {
        title: dto.title ?? 'Business playbook',
        description: dto.description ?? '',
        pages: dto.pages ?? 1,
        format: dto.format ?? 'PDF',
        chapters: [],
        readingSections: [],
        ...data,
      },
    });
  }

  async getPlaybook(): Promise<PlaybookResponse> {
    // Single-row resource: no id is client-suppliable per the contract, so
    // we return the first (and only) seeded Playbook row.
    const playbook = await this.prisma.playbook.findFirst({
      orderBy: { id: 'asc' },
    });

    if (!playbook) {
      throw new NotFoundException('Playbook not found');
    }

    return {
      ...playbook,
      chapters: playbook.chapters as unknown as PlaybookChapter[],
      readingSections:
        playbook.readingSections as unknown as PlaybookReadingSection[],
    };
  }
}
