// Contract test for FIX-107 (G-627): a school course can be saved (SC3's bookmark), listed in Saved (M30) and counted.
//
// Real HTTP against the caller's DATABASE_URL, with real RS256 tokens from
// mock-wawu-id (its port from WAWU_ID_JWKS_URL, else 4001), like the ME-10
// spec. The rows it writes (a school and two courses) are
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

const SCHOOL_NAME = 'FIX-107 test school';

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

interface Who {
  sub: string;
  token: string;
}

let nonce = 0;
async function register(label: string): Promise<Who> {
  nonce += 1;
  const tag = `${Date.now().toString().slice(-8)}${nonce}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Saved Course ${label}`,
      email: `saved-course-${label}-${tag}@test.wawu.dev`,
      phone: `+2347${tag}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`register ${label} failed: ${res.status}`);
  const b = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: b.user.id, token: b.accessToken };
}

describe('FIX-107: saving a school course (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ana: Who;
  let bayo: Who;
  let schoolId: string;
  let courseId: string;
  let courseB: string;

  const http = () => request(app.getHttpServer() as Server);
  const as = (who: Who, method: 'get' | 'put' | 'delete', url: string) =>
    http()[method](url).set('Authorization', `Bearer ${who.token}`);
  const listed = async (who: Who, type = 'all') =>
    dataOf<{
      items: Array<{
        kind: string;
        savedAt: string;
        course: {
          id: string;
          title: string;
          schoolName: string;
          weeks: number;
          priceKobo: number;
        } | null;
      }>;
    }>(await as(who, 'get', `/me/saved?type=${type}`).expect(200)).items;
  const savedCount = async (who: Who) =>
    dataOf<MeCountsView>(await as(who, 'get', '/me/counts').expect(200)).saved;

  async function cleanUp(): Promise<void> {
    await prisma.school.deleteMany({ where: { name: SCHOOL_NAME } });
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
    ana = await register('ana');
    bayo = await register('bayo');
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        PurchaseModule,
        ContentPieceModule,
        DirectMessageModule,
        FollowRelationshipModule,
        BlockedAccountModule,
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
    await cleanUp();
    const school = await prisma.school.create({
      data: {
        name: SCHOOL_NAME,
        location: 'Yaba, Lagos',
        category: 'tech',
        about: 'Created by me-saved-courses.contract.spec.',
        reportEmail: 'report@school.test',
      },
    });
    schoolId = school.id;
    const make = (title: string) =>
      prisma.schoolCourse.create({
        data: {
          schoolId,
          title,
          weeks: 12,
          mode: 'online',
          syllabus: ['One'],
          outcomes: ['Certificate'],
          priceKobo: 15_000_000,
        },
      });
    courseId = (await make('Product design')).id;
    courseB = (await make('Data basics')).id;
  });

  afterAll(async () => {
    if (prisma) await cleanUp();
    await app?.close();
    mockWawuId?.kill();
  });

  it('a person saves a course, sees it saved, and saving again changes nothing', async () => {
    expect(
      dataOf(await as(ana, 'get', `/me/saved/courses/${courseId}`).expect(200)),
    ).toEqual({ courseId, saved: false });
    expect(
      dataOf(await as(ana, 'put', `/me/saved/courses/${courseId}`).expect(200)),
    ).toEqual({ courseId, saved: true });
    const first = await prisma.savedSchoolCourse.findUniqueOrThrow({
      where: { userWawuId_courseId: { userWawuId: ana.sub, courseId } },
    });
    await as(ana, 'put', `/me/saved/courses/${courseId}`).expect(200);
    const again = await prisma.savedSchoolCourse.findMany({
      where: { userWawuId: ana.sub },
    });
    expect(again).toHaveLength(1);
    expect(again[0].savedAt).toEqual(first.savedAt);
    expect(
      dataOf(await as(ana, 'get', `/me/saved/courses/${courseId}`).expect(200)),
    ).toEqual({ courseId, saved: true });
    // Another person's bookmark is their own.
    expect(
      dataOf(
        await as(bayo, 'get', `/me/saved/courses/${courseId}`).expect(200),
      ),
    ).toEqual({ courseId, saved: false });
  });

  it('Saved lists the course with the school, the length and the fee, in All and in its own tab, and counts it', async () => {
    const before = await savedCount(ana);
    await as(ana, 'put', `/me/saved/courses/${courseB}`).expect(200);
    expect(await savedCount(ana)).toBe(before + 1);
    const all = await listed(ana);
    const rows = all.filter((i) => i.kind === 'course');
    expect(rows.map((r) => r.course?.title)).toEqual([
      'Data basics',
      'Product design',
    ]);
    expect(rows[0].course).toMatchObject({
      schoolName: SCHOOL_NAME,
      weeks: 12,
      priceKobo: 15_000_000,
    });
    const tab = await listed(ana, 'courses');
    expect(tab.map((r) => r.kind)).toEqual(['course', 'course']);
    expect(
      (await listed(ana, 'content')).filter((i) => i.kind === 'course'),
    ).toHaveLength(0);
    expect(await listed(bayo, 'courses')).toHaveLength(0);
  });

  it('taking a save back works, twice, and for a course since hidden', async () => {
    await as(ana, 'delete', `/me/saved/courses/${courseB}`).expect(200);
    expect(
      dataOf(
        await as(ana, 'delete', `/me/saved/courses/${courseB}`).expect(200),
      ),
    ).toEqual({ courseId: courseB, saved: false });
    expect((await listed(ana, 'courses')).map((r) => r.course?.id)).toEqual([
      courseId,
    ]);
  });

  it('a hidden course or school is not saved, not listed and not counted, and comes back when shown', async () => {
    const withIt = await savedCount(ana);
    await prisma.schoolCourse.update({
      where: { id: courseId },
      data: { hiddenAt: new Date() },
    });
    expect(await listed(ana, 'courses')).toHaveLength(0);
    expect(await savedCount(ana)).toBe(withIt - 1);
    await as(bayo, 'put', `/me/saved/courses/${courseId}`).expect(404);
    await as(bayo, 'get', `/me/saved/courses/${courseId}`).expect(404);
    await prisma.schoolCourse.update({
      where: { id: courseId },
      data: { hiddenAt: null },
    });
    await prisma.school.update({
      where: { id: schoolId },
      data: { hiddenAt: new Date() },
    });
    expect(await listed(ana, 'courses')).toHaveLength(0);
    await as(bayo, 'put', `/me/saved/courses/${courseId}`).expect(404);
    await prisma.school.update({
      where: { id: schoolId },
      data: { hiddenAt: null },
    });
    expect(await listed(ana, 'courses')).toHaveLength(1);
    expect(await savedCount(ana)).toBe(withIt);
  });

  it('a course that does not exist is a 404 and an id that is not an id is a 400', async () => {
    await as(ana, 'put', `/me/saved/courses/${randomUUID()}`).expect(404);
    await as(ana, 'put', '/me/saved/courses/not-an-id').expect(400);
    await http().put(`/me/saved/courses/${courseId}`).expect(401);
  });

  it('deleting the course takes the saves with it', async () => {
    await prisma.schoolCourse.delete({ where: { id: courseId } });
    expect(await prisma.savedSchoolCourse.count({ where: { courseId } })).toBe(
      0,
    );
  });
});
