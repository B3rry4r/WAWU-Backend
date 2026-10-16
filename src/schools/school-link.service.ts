import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { isWebAddress, newLinkCode, trackedUrl } from './school-link';
import type { SchoolApplyLinkView } from './school-link.views';

/** Tries at a free code before giving up; 32^4 codes, so a second try is rare. */
const CODE_TRIES = 10;

/** Rows the app may see: each level checked on its own (SCHOOLS-02). */
const SHOWN = { hiddenAt: null } as const;

/**
 * SC9, "Apply on their site" (SCHOOLS-10). Two reads of one thing: the link
 * the sheet prints (no record), and the tap on "Continue to their site" (one
 * row in SchoolLinkClick, then the link). The link is the school's own
 * `applyUrl` with the school's code added; the person never goes in it.
 */
@Injectable()
export class SchoolLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /schools/courses/{id}/apply-link: what SC9 prints. Records nothing. */
  async link(courseId: string): Promise<SchoolApplyLinkView> {
    const { view } = await this.resolve(courseId);
    return view;
  }

  /**
   * POST /schools/courses/{id}/apply-click: one tap, one row (who, which
   * course, when), then the link to open. The row is written before the link
   * is handed out, so a link that was opened was counted.
   */
  async click(
    courseId: string,
    userWawuId: string,
  ): Promise<SchoolApplyLinkView> {
    const { view, schoolId } = await this.resolve(courseId);
    await this.prisma.schoolLinkClick.create({
      data: { schoolId, courseId, userWawuId },
    });
    return view;
  }

  /** The shown course, its school's address and code, as the view. */
  private async resolve(
    courseId: string,
  ): Promise<{ view: SchoolApplyLinkView; schoolId: string }> {
    const course = await this.prisma.schoolCourse.findFirst({
      where: { id: courseId, ...SHOWN, school: SHOWN },
      select: { id: true, school: { select: { id: true, applyUrl: true } } },
    });
    if (!course) throw new NotFoundException('Course not found');

    const applyUrl = course.school.applyUrl;
    if (!applyUrl || !isWebAddress(applyUrl)) {
      throw new NotFoundException(
        'This school does not take sign-ups on its own site',
      );
    }
    const code = await this.codeFor(course.school.id);
    const url = trackedUrl(applyUrl, code) as string;
    return {
      view: { courseId: course.id, code, url },
      schoolId: course.school.id,
    };
  }

  /**
   * The school's code, made the first time it is asked for. `skipDuplicates`
   * is INSERT ... ON CONFLICT DO NOTHING on every unique key, so two people
   * asking at once, or a code another school already holds, never error: the
   * row is read back, and if this school still has none the next code is
   * tried.
   */
  private async codeFor(schoolId: string): Promise<string> {
    for (let i = 0; i < CODE_TRIES; i += 1) {
      const have = await this.prisma.schoolLink.findUnique({
        where: { schoolId },
        select: { code: true },
      });
      if (have) return have.code;
      await this.prisma.schoolLink.createMany({
        data: [{ schoolId, code: newLinkCode() }],
        skipDuplicates: true,
      });
    }
    throw new Error(`No free school link code after ${CODE_TRIES} tries`);
  }
}
