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
