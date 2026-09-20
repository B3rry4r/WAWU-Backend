// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// build brief) — same convention as every other Phase 5 contract spec
// (see src/notification/tests/notification.contract.spec.ts).
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CourseEnrollmentModule } from '../course-enrollment.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief / src/learn-entitlement's contract spec).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user, already enrolled in the export course via seed
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // creator (1 free-course slot), no enrollments seeded
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // creator (1 free-course slot), no enrollments seeded

const LEARN_COURSE_EXPORT = '50000000-0000-4000-8000-000000000001'; // USER_PLAIN is already enrolled here (seed)
const LEARN_COURSE_SOCIAL = '50000000-0000-4000-8000-000000000002'; // unenrolled by anyone at seed time
const NON_EXISTENT_COURSE = '50000000-0000-4000-8000-00000000dead';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('CourseEnrollment (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainUserToken: string;
  let basicCreatorToken: string;
  let proCreatorToken: string;

  beforeAll(async () => {
    // Reuse an already-running mock WAWU ID if present, otherwise spawn one
    // for this test run (conventions.md § Local test environment).
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    plainUserToken = await login('user@test.wawu.dev');
    basicCreatorToken = await login('creator-basic@test.wawu.dev');
    proCreatorToken = await login('creator-pro@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, CourseEnrollmentModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
  }, 30000);

  afterAll(async () => {
    // Undo any enrollment this spec created so the seed state is clean for
    // other resources' specs (e.g. learn-entitlement's) run in the same DB.
    await prisma.courseEnrollment.deleteMany({
      where: {
        courseId: LEARN_COURSE_SOCIAL,
        userWawuId: { in: [USER_CREATOR_BASIC, USER_CREATOR_PRO] },
      },
    });
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('POST /learn/courses/:id/enrol', () => {
    it('404s for a course id that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/learn/courses/${NON_EXISTENT_COURSE}/enrol`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(404);
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/learn/courses/${LEARN_COURSE_SOCIAL}/enrol`)
        .expect(401);
    });

    it('403s a plain (non-creator) user — 0 free-course slots, nothing to spend', async () => {
      const res = await request(app.getHttpServer())
        .post(`/learn/courses/${LEARN_COURSE_SOCIAL}/enrol`)
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(403);

      expect(res.body.data).toBeNull();
    });

    it('enrols a creator (1 slot) and returns the fresh LearnEntitlement + externalHostUrl (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/learn/courses/${LEARN_COURSE_SOCIAL}/enrol`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        freeCoursesTotal: 1,
        freeCoursesUsed: 1,
        enrolledCourseIds: [LEARN_COURSE_SOCIAL],
        externalHostUrl: expect.any(String),
      });
    });

    it('is idempotent: re-enrolling the same creator in the same course does not error and does not double-spend the slot', async () => {
      const res = await request(app.getHttpServer())
        .post(`/learn/courses/${LEARN_COURSE_SOCIAL}/enrol`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        freeCoursesTotal: 1,
        freeCoursesUsed: 1,
        enrolledCourseIds: [LEARN_COURSE_SOCIAL],
        externalHostUrl: expect.any(String),
      });
    });

    it("403s a creator's 2nd distinct-course enrol attempt — slot already spent", async () => {
      const res = await request(app.getHttpServer())
        .post(`/learn/courses/${LEARN_COURSE_EXPORT}/enrol`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(403);

      expect(res.body.data).toBeNull();
    });

    it('gives every other creator the SAME 1 slot, because the tier ladder is gone (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/learn/courses/${LEARN_COURSE_SOCIAL}/enrol`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        freeCoursesTotal: 1,
        freeCoursesUsed: 1,
        enrolledCourseIds: [LEARN_COURSE_SOCIAL],
        externalHostUrl: expect.any(String),
      });
    });

    it('400s a malformed course id (not a UUID)', async () => {
      await request(app.getHttpServer())
        .post('/learn/courses/not-a-uuid/enrol')
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .expect(400);
    });
  });
});
