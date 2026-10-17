// Contract test for task ME-03: GET /me/counts carries `enrolledCourses`, the
// Me menu's "My courses 1 enrolled" (M7).
//
// Real HTTP against the caller's DATABASE_URL, with real RS256 tokens from
// mock-wawu-id (its port from WAWU_ID_JWKS_URL, else 4001), like the ME-10
// spec. The rows it writes (a school, its courses, intakes and enrolments) are
// removed after, so the seeded world is left as it was found.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { NotificationModule } from '../../notification/notification.module';
import { PurchaseModule } from '../../purchase/purchase.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { DirectMessageModule } from '../../direct-message/direct-message.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { MeModule } from '../me.module';
import { MeCoursesService } from '../me-courses.service';
import type { MeCountsView } from '../me-view.type';

const dataOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

// Seeded WAWU IDs (mock-wawu-id/server.js, prisma/seed.ts).
const PLAIN = '00000000-0000-4000-8000-000000000001';
const BASIC = '00000000-0000-4000-8000-000000000002';
const SCHOOL_NAME = 'ME-03 test school';

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
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** A calendar day `n` days from today, as YYYY-MM-DD (UTC; the tests keep a day's margin either side). */
const day = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('ME-03: the Me menu counts enrolled courses (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let courses: MeCoursesService;
  let mockWawuId: ChildProcess | undefined;
  let plain: string;
  let basic: string;
  let schoolId: string;

  const http = () => request(app.getHttpServer() as Server);
  const counts = async (token: string): Promise<MeCountsView> =>
    dataOf<MeCountsView>(
      await http()
        .get('/me/counts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200),
    );

  async function cleanUp(): Promise<void> {
    await prisma.schoolEnrolment.deleteMany({
      where: { school: { name: SCHOOL_NAME } },
    });
    await prisma.school.deleteMany({ where: { name: SCHOOL_NAME } });
  }

  async function place(
    who: string,
    opts: {
      status: 'reserved' | 'enrolled' | 'released' | 'refunded';
      startDate: string;
      weeks: number;
    },
  ): Promise<void> {
    const course = await prisma.schoolCourse.create({
      data: {
        schoolId,
        title: `Course ${randomUUID().slice(0, 6)}`,
        weeks: opts.weeks,
        mode: 'online',
        syllabus: ['One'],
        outcomes: ['Certificate'],
        priceKobo: 5_000_000,
      },
    });
    const intake = await prisma.courseIntake.create({
      data: {
        courseId: course.id,
        startDate: new Date(`${opts.startDate}T00:00:00.000Z`),
        schedule: 'Saturdays',
        capacity: 5,
      },
    });
    await prisma.schoolEnrolment.create({
      data: {
        wawuUserId: who,
        schoolId,
        courseId: course.id,
        intakeId: intake.id,
        status: opts.status,
        reference: `WAW-${randomUUID().slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`,
        courseTitle: course.title,
        schoolName: SCHOOL_NAME,
        intakeStartDate: new Date(`${opts.startDate}T00:00:00.000Z`),
        intakeSchedule: 'Saturdays',
        priceKobo: 5_000_000,
        schoolShareKobo: 4_250_000,
        wawuShareKobo: 750_000,
        commissionBps: 1500,
        reservedUntil: new Date(Date.now() + 30 * 60_000),
        enrolledAt: opts.status === 'enrolled' ? new Date() : null,
      },
    });
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    plain = await login('user@test.wawu.dev');
    basic = await login('creator-basic@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        BlockedAccountModule,
        PurchaseModule,
        ContentPieceModule,
        DirectMessageModule,
        FollowRelationshipModule,
        MeModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    courses = moduleRef.get(MeCoursesService);
    await cleanUp();
    const school = await prisma.school.create({
      data: {
        name: SCHOOL_NAME,
        category: 'tech',
        location: 'Yaba, Lagos',
        about: 'A test school.',
        reportEmail: 'report@school.test',
      },
    });
    schoolId = school.id;
  }, 40000);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
    mockWawuId?.kill();
  });

  it('serves enrolledCourses beside the other three, as a whole number, 0 for a person with none', async () => {
    const view = await counts(plain);
    expect(Number.isInteger(view.enrolledCourses)).toBe(true);
    expect(view.enrolledCourses).toBe(0);
    expect(Number.isInteger(view.purchases)).toBe(true);
    expect(Number.isInteger(view.saved)).toBe(true);
    expect(Number.isInteger(view.unreadNotifications)).toBe(true);
  });

  it('counts paid places whose class has not finished, and nothing else', async () => {
    await place(PLAIN, { status: 'enrolled', startDate: day(30), weeks: 6 }); // upcoming
    await place(PLAIN, { status: 'enrolled', startDate: day(-7), weeks: 6 }); // running
    await place(PLAIN, { status: 'enrolled', startDate: day(-100), weeks: 4 }); // over
    await place(PLAIN, { status: 'reserved', startDate: day(20), weeks: 6 }); // held, not paid
    await place(PLAIN, { status: 'refunded', startDate: day(20), weeks: 6 }); // fee went back
    await place(PLAIN, { status: 'released', startDate: day(20), weeks: 6 }); // given back unpaid
    expect((await counts(plain)).enrolledCourses).toBe(2);
  });

  it('counts only the caller’s own places', async () => {
    expect((await counts(basic)).enrolledCourses).toBe(0);
    await place(BASIC, { status: 'enrolled', startDate: day(10), weeks: 3 });
    expect((await counts(basic)).enrolledCourses).toBe(1);
    expect((await counts(plain)).enrolledCourses).toBe(2);
  });

  it('a class ends on its last day, in Lagos: still enrolled that day, over the next', async () => {
    // Starts 2026-03-02, 2 weeks: the last day is 2026-03-15 (start + 13 days).
    await place(BASIC, {
      status: 'enrolled',
      startDate: '2026-03-02',
      weeks: 2,
    });
    const before = await courses.enrolledCount(
      BASIC,
      new Date('2026-03-15T22:30:00.000Z'), // 23:30 in Lagos on the 15th
    );
    const after = await courses.enrolledCount(
      BASIC,
      new Date('2026-03-15T23:30:00.000Z'), // 00:30 in Lagos on the 16th
    );
    expect(before - after).toBe(1);
  });

  it('needs a signed-in caller', async () => {
    await http().get('/me/counts').expect(401);
  });
});
