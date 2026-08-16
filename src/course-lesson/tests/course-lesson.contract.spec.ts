import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CourseLessonModule } from '../course-lesson.module';
import { CourseLessonService } from '../course-lesson.service';

/**
 * CourseLesson's frozen contract (registry.json) declares `"endpoints": []`
 * — confirmed intentional by schema.prisma's own doc comment on the
 * CourseLesson model. There is no controller and no HTTP surface to hit, so
 * the usual "valid request / 400 / 401-403" endpoint matrix does not apply
 * here (vacuously satisfied — zero endpoints, zero endpoint tests owed).
 * What DOES need contract-level verification is the one thing this resource
 * actually contributes: `CourseLessonService.getLessonsForContent`, which a
 * later wave's ContentPiece module will inject to assemble the
 * content-detail response. These tests exercise it directly against the
 * seeded test DB.
 */

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly.
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // has a completed Purchase of the seeded course
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // neither creator nor buyer of the seeded course
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // creator of the seeded course

const CONTENT_CAC_COURSE = '10000000-0000-4000-8000-000000000001'; // SEEDED: CAC in 7 days (paid course, 2 lessons)
const CONTENT_MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002'; // SEEDED: free video, no lessons
const NONEXISTENT_CONTENT_ID = 'ffffffff-0000-4000-8000-000000000099';

const LESSON_CAC_1 = '11000000-0000-4000-8000-000000000001';
const LESSON_CAC_2 = '11000000-0000-4000-8000-000000000002';

describe('CourseLesson (contract)', () => {
  let service: CourseLessonService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        CourseLessonModule,
      ],
    }).compile();

    service = moduleRef.get(CourseLessonService);
    prisma = moduleRef.get(PrismaService);
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('getLessonsForContent — valid request, contracted shape', () => {
    it('returns the seeded lessons in order with the CourseLessonResponse shape', async () => {
      const lessons = await service.getLessonsForContent(
        CONTENT_CAC_COURSE,
        USER_PLAIN,
      );

      expect(lessons).toHaveLength(2);
      expect(lessons.map((l) => l.id)).toEqual([LESSON_CAC_1, LESSON_CAC_2]);
      expect(lessons[0]).toEqual(
        expect.objectContaining({
          id: LESSON_CAC_1,
          contentId: CONTENT_CAC_COURSE,
          title: 'Reserving your business name',
          order: 1,
          durationLabel: '18m',
        }),
      );
      for (const lesson of lessons) {
        expect(typeof lesson.locked).toBe('boolean');
      }
    });

    it('unlocks for a requester with a completed Purchase of the content', async () => {
      const lessons = await service.getLessonsForContent(
        CONTENT_CAC_COURSE,
        USER_PLAIN,
      );
      expect(lessons.every((l) => l.locked === false)).toBe(true);
    });

    it('unlocks for the content creator viewing their own course', async () => {
      const lessons = await service.getLessonsForContent(
        CONTENT_CAC_COURSE,
        USER_CREATOR_PRO,
      );
      expect(lessons.every((l) => l.locked === false)).toBe(true);
    });

    it('locks for a requester who neither purchased nor created the paid course', async () => {
      const lessons = await service.getLessonsForContent(
        CONTENT_CAC_COURSE,
        USER_CREATOR_BASIC,
      );
      expect(lessons).toHaveLength(2);
      expect(lessons.every((l) => l.locked === true)).toBe(true);
    });

    it('never locks lessons on free content, regardless of requester', async () => {
      // CONTENT_MAKEUP_VIDEO is free and has no lessons seeded (it's a video,
      // not a course) — this asserts the lock rule short-circuits on
      // accessType alone without needing lesson rows to prove it.
      const lessons = await service.getLessonsForContent(
        CONTENT_MAKEUP_VIDEO,
        USER_CREATOR_BASIC,
      );
      expect(lessons).toEqual([]);
    });

    it('returns [] for content that does not exist, rather than throwing', async () => {
      await expect(
        service.getLessonsForContent(NONEXISTENT_CONTENT_ID, USER_PLAIN),
      ).resolves.toEqual([]);
    });
  });

  describe('getLessonsForContent — invalid input', () => {
    it('treats a malformed contentId as "not found" (400-equivalent: empty result, no throw)', async () => {
      await expect(
        service.getLessonsForContent('not-a-uuid', USER_PLAIN),
      ).resolves.toEqual([]);
    });
  });

  describe('getLessonsForContent — no requester (unauthenticated-equivalent)', () => {
    it('locks paid-course lessons for an anonymous requester', async () => {
      const lessons = await service.getLessonsForContent(
        CONTENT_CAC_COURSE,
        undefined,
      );
      expect(lessons).toHaveLength(2);
      expect(lessons.every((l) => l.locked === true)).toBe(true);
    });
  });
});
