import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LearnCourseModule } from '../learn-course.module';

/**
 * Contract tests for registry.json "LearnCourse" — both endpoints are
 * `roles: ["any"]` (public catalog, no WawuAuthGuard), so there is no
 * auth/role test per endpoint here (nothing to be missing/wrong-role about).
 *
 * Uses the seeded row planted by prisma/seed.ts (id 50000000-0000-4000-8000-000000000001,
 * distinctive "SEEDED: Export Basics for African Creators" title) run against
 * wawu_hub_test — no invented fixtures.
 */
describe('LearnCourse (contract)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const SEEDED_COURSE_ID = '50000000-0000-4000-8000-000000000001';
  const SEEDED_COURSE_TITLE = 'SEEDED: Export Basics for African Creators';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, LearnCourseModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /learn/courses', () => {
    it('returns the contracted LearnCourse[] envelope, including the seeded course', async () => {
      const res = await request(app.getHttpServer()).get('/learn/courses').expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 200,
          message: 'OK',
          data: expect.any(Array),
        }),
      );
      // Plain array shape per the contract's `LearnCourse[]` response — no
      // `pagination` key (that's only added by the interceptor for the
      // `{items, currentPage, perPage, total}` paginated-list shape, which
      // this endpoint deliberately does not use).
      expect(res.body.pagination).toBeUndefined();

      const seeded = (res.body.data as Array<Record<string, unknown>>).find(
        (c) => c.id === SEEDED_COURSE_ID,
      );
      expect(seeded).toBeDefined();
      expect(seeded).toEqual(
        expect.objectContaining({
          id: SEEDED_COURSE_ID,
          title: SEEDED_COURSE_TITLE,
          category: expect.any(String),
          hours: expect.any(Number),
          certificate: expect.any(Boolean),
          overview: expect.any(String),
          whatItCovers: expect.any(Array),
          externalHostUrl: expect.any(String),
        }),
      );
    });

    it('requires no auth — an unauthenticated request still succeeds (roles: any)', async () => {
      await request(app.getHttpServer()).get('/learn/courses').expect(200);
    });
  });

  describe('GET /learn/courses/:id', () => {
    it('returns the contracted LearnCourse shape for the seeded course', async () => {
      const res = await request(app.getHttpServer())
        .get(`/learn/courses/${SEEDED_COURSE_ID}`)
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 200,
          message: 'OK',
          data: expect.objectContaining({
            id: SEEDED_COURSE_ID,
            title: SEEDED_COURSE_TITLE,
            category: expect.any(String),
            hours: expect.any(Number),
            certificate: expect.any(Boolean),
            overview: expect.any(String),
            whatItCovers: expect.any(Array),
            externalHostUrl: expect.any(String),
          }),
        }),
      );
    });

    it('400s on a malformed (non-UUID) id — invalid payload', async () => {
      const res = await request(app.getHttpServer()).get('/learn/courses/not-a-uuid').expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 400,
          data: null,
        }),
      );
    });

    it('404s on a well-formed id that does not exist', async () => {
      const res = await request(app.getHttpServer())
        .get('/learn/courses/00000000-0000-4000-8000-000000009999')
        .expect(404);

      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 404,
          data: null,
        }),
      );
    });

    it('requires no auth — an unauthenticated request still succeeds (roles: any)', async () => {
      await request(app.getHttpServer()).get(`/learn/courses/${SEEDED_COURSE_ID}`).expect(200);
    });
  });

  it('seeded course row is reachable directly via Prisma (sanity check on the test DB fixture)', async () => {
    const row = await prisma.learnCourse.findUnique({ where: { id: SEEDED_COURSE_ID } });
    expect(row?.title).toBe(SEEDED_COURSE_TITLE);
  });
});
