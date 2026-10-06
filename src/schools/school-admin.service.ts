import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type {
  CreateCourseDto,
  CreateIntakeDto,
  CreateSchoolDto,
  ListSchoolsDto,
  UpdateCourseDto,
  UpdateIntakeDto,
  UpdateSchoolDto,
} from './school-admin.dto';
import {
  type AdminCourseView,
  type AdminIntakeView,
  type AdminSchoolDetail,
  type AdminSchoolsPage,
  courseView,
  intakeView,
  schoolDetail,
  schoolSummary,
} from './school-admin.views';

const DEFAULT_PAGE = 25;

/** `hidden` in a body becomes the column: true stamps now, false clears. */
function hiddenAt(hidden: boolean | undefined): { hiddenAt?: Date | null } {
  if (hidden === undefined) return {};
  return { hiddenAt: hidden ? new Date() : null };
}

/** Only the fields the body carries; Prisma treats undefined as "leave alone". */
function without<T extends object>(dto: T): Omit<T, 'hidden'> {
  const rest: Partial<T> & { hidden?: boolean } = { ...dto };
  delete rest.hidden;
  return rest as Omit<T, 'hidden'>;
}

/**
 * SCHOOLS-02: how the dashboard adds, edits and hides schools, their courses
 * and each course's dated intakes. Nothing here deletes: a school that should
 * not show is hidden, so enrolments (SCHOOLS-07) keep what they point at.
 * `seatsTaken` is never written here; SCHOOLS-07's conditional claim owns it.
 */
@Injectable()
export class SchoolAdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- schools ------------------------------------------------------------

  async createSchool(dto: CreateSchoolDto): Promise<AdminSchoolDetail> {
    const row = await this.prisma.school.create({
      data: {
        name: dto.name,
        category: dto.category,
        location: dto.location,
        foundedYear: dto.foundedYear ?? null,
        expertise: dto.expertise ?? [],
        about: dto.about,
        logo: dto.logo ?? null,
        applyUrl: dto.applyUrl ?? null,
        reportEmail: dto.reportEmail,
      },
      include: { courses: { include: { intakes: true } } },
    });
    return schoolDetail(row);
  }

  async listSchools(q: ListSchoolsDto): Promise<AdminSchoolsPage> {
    const limit = q.limit ?? DEFAULT_PAGE;
    const where: Prisma.SchoolWhereInput = {
      ...(q.category ? { category: q.category } : {}),
      ...(q.hidden === undefined
        ? {}
        : { hiddenAt: q.hidden ? { not: null } : null }),
    };
    const rows = await this.prisma.school.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { _count: { select: { courses: true } } },
    });
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return {
      items: page.map(schoolSummary),
      nextCursor: more ? page[page.length - 1].id : null,
    };
  }

  async getSchool(id: string): Promise<AdminSchoolDetail> {
    const row = await this.prisma.school.findUnique({
      where: { id },
      include: {
        courses: {
          orderBy: { createdAt: 'asc' },
          include: { intakes: { orderBy: { startDate: 'asc' } } },
        },
      },
    });
    if (!row) throw new NotFoundException('School not found');
    return schoolDetail(row);
  }

  async updateSchool(
    id: string,
    dto: UpdateSchoolDto,
  ): Promise<AdminSchoolDetail> {
    await this.requireSchool(id);
    await this.prisma.school.update({
      where: { id },
      data: { ...without(dto), ...hiddenAt(dto.hidden) },
    });
    return this.getSchool(id);
  }

  // ---- courses ------------------------------------------------------------

  async createCourse(
    schoolId: string,
    dto: CreateCourseDto,
  ): Promise<AdminCourseView> {
    await this.requireSchool(schoolId);
    const row = await this.prisma.schoolCourse.create({
      data: {
        schoolId,
        title: dto.title,
        weeks: dto.weeks,
        mode: dto.mode,
        syllabus: dto.syllabus ?? [],
        outcomes: dto.outcomes ?? [],
        priceKobo: dto.priceKobo,
      },
      include: { intakes: true },
    });
    return courseView(row);
  }

  async getCourse(id: string): Promise<AdminCourseView> {
    const row = await this.prisma.schoolCourse.findUnique({
      where: { id },
      include: { intakes: { orderBy: { startDate: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Course not found');
    return courseView(row);
  }

  async updateCourse(
    id: string,
    dto: UpdateCourseDto,
  ): Promise<AdminCourseView> {
    await this.requireCourse(id);
    await this.prisma.schoolCourse.update({
      where: { id },
      data: { ...without(dto), ...hiddenAt(dto.hidden) },
    });
    return this.getCourse(id);
  }

  // ---- intakes ------------------------------------------------------------

  async createIntake(
    courseId: string,
    dto: CreateIntakeDto,
  ): Promise<AdminIntakeView> {
    await this.requireCourse(courseId);
    const row = await this.prisma.courseIntake.create({
      data: {
        courseId,
        startDate: new Date(`${dto.startDate}T00:00:00.000Z`),
        schedule: dto.schedule,
        location: dto.location ?? null,
        capacity: dto.capacity,
      },
    });
    return intakeView(row);
  }

  async getIntake(id: string): Promise<AdminIntakeView> {
    const row = await this.prisma.courseIntake.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Intake not found');
    return intakeView(row);
  }

  async updateIntake(
    id: string,
    dto: UpdateIntakeDto,
  ): Promise<AdminIntakeView> {
    const { startDate, ...rest } = without(dto);
    const data: Prisma.CourseIntakeUpdateManyMutationInput = {
      ...rest,
      ...(startDate
        ? { startDate: new Date(`${startDate}T00:00:00.000Z`) }
        : {}),
      ...hiddenAt(dto.hidden),
    };
    // One conditional write: the capacity may not drop below the seats already
    // taken, and a seat claim landing between a read and this write cannot
    // slip past it. Zero rows means the intake is missing or the seats win.
    const res = await this.prisma.courseIntake.updateMany({
      where: {
        id,
        ...(dto.capacity === undefined
          ? {}
          : { seatsTaken: { lte: dto.capacity } }),
      },
      data,
    });
    if (res.count === 0) {
      await this.getIntake(id);
      throw new ConflictException(
        'Capacity cannot be lower than the seats already taken',
      );
    }
    return this.getIntake(id);
  }

  // ---- helpers ------------------------------------------------------------

  private async requireSchool(id: string): Promise<void> {
    const n = await this.prisma.school.count({ where: { id } });
    if (n === 0) throw new NotFoundException('School not found');
  }

  private async requireCourse(id: string): Promise<void> {
    const n = await this.prisma.schoolCourse.count({ where: { id } });
    if (n === 0) throw new NotFoundException('Course not found');
  }
}
