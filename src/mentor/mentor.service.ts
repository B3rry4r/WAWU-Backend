import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Mentor } from '../common/types';

@Injectable()
export class MentorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /services/mentors — registry.json § Mentor. Optional `category`
   * filter. Mentors are FREE (product-truths.json: no payment step here) —
   * this is reference/directory data, no ordering contract given, sorted
   * by name for a stable, predictable list.
   */
  async list(category?: string): Promise<Mentor[]> {
    return this.prisma.mentor.findMany({
      where: category ? { category } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  /** GET /services/mentors/:id — registry.json § Mentor. */
  async findOne(id: string): Promise<Mentor> {
    const mentor = await this.prisma.mentor.findUnique({ where: { id } });
    if (!mentor) {
      throw new NotFoundException('Mentor not found');
    }
    return mentor;
  }
}
