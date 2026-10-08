import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isCleanText } from '../admin/legal-documents/policy-input';
import type { ListPublicSchoolsDto } from './schools.dto';
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

/** Longest name a cursor may carry (a school name is far shorter). */
const MAX_CURSOR_NAME = 300;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An opaque position: base64url of [name, id]. */
export function encodeCursor(row: { name: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.name, row.id]), 'utf8').toString(
    'base64url',
  );
}

/** A cursor this server did not give out (or altered) is a 400, never a 500. */
export function decodeCursor(cursor: string): { name: string; id: string } {
  const bad = () =>
    new BadRequestException('cursor is not one this server gave out');
  if (!/^[A-Za-z0-9_-]{1,1000}$/.test(cursor)) throw bad();
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    typeof v[0] !== 'string' ||
    typeof v[1] !== 'string' ||
    v[0].length > MAX_CURSOR_NAME ||
    !isCleanText(v[0]) ||
    !UUID_RE.test(v[1])
  )
    throw bad();
  const name = v[0];
  const id = v[1].toLowerCase();
  if (encodeCursor({ name, id }) !== cursor) throw bad();
  return { name, id };
}

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
    const t = term.trim();
    if (t === '') return [];
    if (!isCleanText(t))
      throw new BadRequestException(
        'q must have text in it, with no null characters or broken characters',
      );
    return (await this.list({ q: t, limit: 20 })).items;
  }

  /** GET /schools/{id} */
  async school(id: string): Promise<PublicSchoolDetail> {
    const row = await this.prisma.school.findFirst({
      where: { id, ...SHOWN },
      include: {
        courses: {
          where: SHOWN,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: {
            intakes: { where: SHOWN, orderBy: { startDate: 'asc' } },
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
        intakes: {
          where: SHOWN,
          orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        },
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
