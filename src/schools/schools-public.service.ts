import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { ListPublicSchoolsDto } from './schools.dto';
import { decodeCursor, encodeCursor } from './schools-cursor';
import { schoolOrderBy, schoolsAfter } from './schools-order';
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
    // Keyset paging on the name's sort key and the id: the cursor holds the
    // position, not a row that must still be shown, so hiding or filtering
    // out the school a page ended on skips nothing. The order is written
    // into the query (schools-order.ts), so the page's ORDER BY and the
    // cursor's comparison are the same on every database, whatever collation
    // it was created with.
    const place = await this.prisma.$queryRaw<{ id: string; name: string }[]>(
      Prisma.sql`
        SELECT s."id", s."name"
          FROM "School" s
         WHERE ${this.listWhere(q.category, q.q)}
           AND ${after ? schoolsAfter(after) : Prisma.sql`true`}
         ${schoolOrderBy()}
         LIMIT ${limit + 1}`,
    );
    const more = place.length > limit;
    const pageIds = (more ? place.slice(0, limit) : place).map((r) => r.id);
    if (pageIds.length === 0) return { items: [], nextCursor: null };
    const found = await this.prisma.school.findMany({
      where: { id: { in: pageIds }, ...SHOWN },
      include: {
        courses: {
          ...SHOWN_COURSES,
          orderBy: COURSE_ORDER,
          select: { title: true, priceKobo: true },
        },
      },
    });
    // The page's own order, not the order the second read happened to give.
    // A school hidden or removed between the two reads simply drops out.
    const byId = new Map(found.map((r) => [r.id, r]));
    const page = pageIds.flatMap((id) => byId.get(id) ?? []);
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
      // From the position the query gave, so a school that left the list
      // after it was read still marks where the next page starts.
      nextCursor: more ? encodeCursor(place[limit - 1]) : null,
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

  /** The rows the list may show: not hidden, in the category, matching the term. */
  private listWhere(
    category: ListPublicSchoolsDto['category'],
    term: string | undefined,
  ): Prisma.Sql {
    // LIKE reads % and _ as wildcards and \ as its escape; the search term
    // means itself, so each is escaped.
    const like =
      term === undefined
        ? null
        : `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return Prisma.sql`s."hiddenAt" IS NULL
      AND ${
        category
          ? Prisma.sql`s."category" = ${category}::"SchoolCategory"`
          : Prisma.sql`true`
      }
      AND ${
        like === null
          ? Prisma.sql`true`
          : Prisma.sql`(s."name" ILIKE ${like}
              OR s."location" ILIKE ${like}
              OR EXISTS (
                SELECT 1 FROM "SchoolCourse" c
                 WHERE c."schoolId" = s."id"
                   AND c."hiddenAt" IS NULL
                   AND c."title" ILIKE ${like}))`
      }`;
  }
}
