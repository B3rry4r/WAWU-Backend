import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { ListPublicSchoolsDto } from './schools.dto';
import { decodeCursor, encodeCursor } from './schools-cursor';
import {
  courseCard,
  intakeView,
  schoolCard,
  type PublicCourseDetail,
  type PublicSchoolCard,
  type PublicSchoolDetail,
  type PublicSchoolsPage,
} from './schools-public.views';

const DEFAULT_PAGE = 20;
const MATCHED_COURSES = 3;

/**
 * Course creation order, then id: the order the school page lists courses
 * in, and which matching courses a card names first.
 */
const COURSE_ORDER: Prisma.SchoolCourseOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];
/** Soonest first, then id, so two intakes on one day always agree. */
const INTAKE_ORDER: Prisma.CourseIntakeOrderByWithRelationInput[] = [
  { startDate: 'asc' },
  { id: 'asc' },
];

/** Rows the app may see: each level checked on its own (SCHOOLS-02). */
const SHOWN = { hiddenAt: null } as const;
const SHOWN_COURSES = { where: SHOWN } as const;

/**
 * Public schools reads (SCHOOLS-04). Every read serves only rows whose
 * `hiddenAt` is null at each level: a hidden school hides its courses and
 * intakes, a hidden course hides its intakes, a hidden intake is dropped.
 */
@Injectable()
export class SchoolsPublicService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /schools: browse by category, search by name, place or course. */
  async list(q: ListPublicSchoolsDto): Promise<PublicSchoolsPage> {
    const limit = q.limit ?? DEFAULT_PAGE;
    const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
    const filter = this.listWhere(q.category, q.q);
    // Keyset paging on (name, id): the cursor holds the position, not a row
    // that must still be shown, so hiding or filtering out the school a page
    // ended on skips nothing. Both the comparison and the ORDER BY use the
    // columns' own collation, so they agree.
    const where: Prisma.SchoolWhereInput = after
      ? {
          AND: [
            filter,
            {
              OR: [
                { name: { gt: after.name } },
                { name: after.name, id: { gt: after.id } },
              ],
            },
          ],
        }
      : filter;
    const rows = await this.prisma.school.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: {
        courses: {
          ...SHOWN_COURSES,
          orderBy: COURSE_ORDER,
          select: { title: true, priceKobo: true },
        },
      },
    });
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const term = q.q?.toLowerCase();
    return {
      items: page.map((r) =>
        schoolCard(
          r,
          term
            ? r.courses
                .filter((c) => c.title.toLowerCase().includes(term))
                .slice(0, MATCHED_COURSES)
                .map((c) => c.title)
            : [],
        ),
      ),
      nextCursor: more ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /** The `schools` tab of GET /search: the first page of the same match. */
  async searchTab(term: string): Promise<PublicSchoolCard[]> {
    // A term with a NUL or a lone surrogate never reaches here: GET /search
    // refuses it on every tab first (FIX-07, `refuseUnsearchableQuery`).
    const t = term.trim();
    if (t === '') return [];
    return (await this.list({ q: t, limit: 20 })).items;
  }

  /** GET /schools/{id} */
  async school(id: string): Promise<PublicSchoolDetail> {
    const row = await this.prisma.school.findFirst({
      where: { id, ...SHOWN },
      include: {
        courses: {
          where: SHOWN,
          orderBy: COURSE_ORDER,
          include: {
            intakes: { where: SHOWN, orderBy: INTAKE_ORDER },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('School not found');
    return {
      ...schoolCard(row),
      about: row.about,
      applyUrl: row.applyUrl,
      courses: row.courses.map(courseCard),
    };
  }

  /** GET /schools/courses/{id} */
  async course(id: string): Promise<PublicCourseDetail> {
    const row = await this.prisma.schoolCourse.findFirst({
      where: { id, ...SHOWN, school: SHOWN },
      include: {
        school: true,
        intakes: { where: SHOWN, orderBy: INTAKE_ORDER },
      },
    });
    if (!row) throw new NotFoundException('Course not found');
    return {
      id: row.id,
      title: row.title,
      weeks: row.weeks,
      mode: row.mode,
      syllabus: row.syllabus,
      outcomes: row.outcomes,
      priceKobo: row.priceKobo,
      school: {
        id: row.school.id,
        name: row.school.name,
        category: row.school.category,
        location: row.school.location,
        logo: row.school.logo,
        applyUrl: row.school.applyUrl,
      },
      intakes: row.intakes.map(intakeView),
    };
  }

  private listWhere(
    category: ListPublicSchoolsDto['category'],
    term: string | undefined,
  ): Prisma.SchoolWhereInput {
    // LIKE reads % and _ as wildcards and \ as its escape; the search term
    // means itself, so each is escaped.
    const like = term?.replace(/[\\%_]/g, (c) => `\\${c}`);
    return {
      ...SHOWN,
      ...(category ? { category } : {}),
      ...(like
        ? {
            OR: [
              { name: { contains: like, mode: 'insensitive' } },
              { location: { contains: like, mode: 'insensitive' } },
              {
                courses: {
                  some: {
                    ...SHOWN,
                    title: { contains: like, mode: 'insensitive' },
                  },
                },
              },
            ],
          }
        : {}),
    };
  }
}
