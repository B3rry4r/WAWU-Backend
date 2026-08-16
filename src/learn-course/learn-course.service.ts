import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { LearnCourse } from '../common/types';

/**
 * LearnCourse — public catalog of Alison-hosted courses (registry.json
 * "LearnCourse"). Both endpoints are `roles: ["any"]` (public, no auth
 * guard) per the frozen contract — this is a browsable catalog, not
 * user-scoped data.
 */
@Injectable()
export class LearnCourseService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /learn/courses — full catalog, no pagination per the contract's `LearnCourse[]` shape. */
  async findAll(): Promise<LearnCourse[]> {
    return this.prisma.learnCourse.findMany({ orderBy: { title: 'asc' } });
  }

  /** GET /learn/courses/:id — 404s (via AllExceptionsFilter) when the id doesn't exist. */
  async findOne(id: string): Promise<LearnCourse> {
    const course = await this.prisma.learnCourse.findUnique({ where: { id } });
    if (!course) {
      throw new NotFoundException('Course not found');
    }
    return course;
  }
}
