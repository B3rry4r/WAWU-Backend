import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { lagosToday } from '../schools/enrolment/school-enrolment-rules';

/**
 * The Me menu's "My courses 1 enrolled" (M7, task ME-03).
 *
 * WHAT COUNTS. A school place the caller has paid for (`enrolled`) whose class
 * has not finished: the courses they are taking, the paid rows of SC8's Current
 * tab. A held place not yet paid (`reserved`), a fee that went back
 * (`refunded`), a place given back (`released`) and a class that is over are
 * not "enrolled". The end of a class is its start plus `weeks` x 7 days less
 * the one day the start counts, in Lagos, the rule SC8's tabs use
 * (`SchoolEnrolmentService.list`). It reads our own records only.
 */
@Injectable()
export class MeCoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async enrolledCount(me: string, now: Date = new Date()): Promise<number> {
    const today = lagosToday(now);
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "SchoolEnrolment" e
        JOIN "SchoolCourse" c ON c."id" = e."courseId"
       WHERE e."wawuUserId" = ${me}
         AND e."status" = 'enrolled'
         AND (e."intakeStartDate" + (c."weeks" * 7 - 1)) >= ${today}::date`;
    return Number(rows[0]?.n ?? 0);
  }
}
