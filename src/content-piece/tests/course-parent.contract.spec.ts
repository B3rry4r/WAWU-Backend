import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { ContentPieceModule } from '../content-piece.module';

/**
 * FIX-111 (H24, G-HOME-08-1): a piece can say it comes from one of its creator's own courses, and the piece's detail serves that
 * course's title, lesson count and price. The link lives on the piece's side row (`ContentDetail.parentCourseId`), never on the
 * piece, so no response the web reads gains a key. Runs against real Postgres and the mock WAWU ID; every row it makes carries
 * the `FIX111 ` title prefix and is removed afterwards, and the owner's place count is put back as found.
 */
const OWNER = '00000000-0000-4000-8000-000000000003'; // creator-pro
const OTHER_CREATOR = '00000000-0000-4000-8000-000000000002'; // creator-basic
const PREFIX = 'FIX111 ';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

type Detail = {
  contentId: string;
  parentCourse: {
    id: string;
    title: string;
    lessonCount: number;
    price: number;
    previewAssetUrl: string | null;
  } | null;
};

describe('A piece that comes from a course (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let ownedMock = false;
  let ownerToken: string;
  let plainToken: string;
  let ownerSlots = 0;
  let seq = 0;

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => `Bearer ${token}`;

  async function piece(over: Record<string, unknown> = {}) {
    seq += 1;
    return prisma.contentPiece.create({
      data: {
        slug: `fix111-${Date.now()}-${seq}`,
        creatorWawuId: OWNER,
        contentType: 'course',
        title: `${PREFIX}course ${seq}`,
        description: 'A description',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 8000,
        previewAssetUrl: 'https://cdn.example.com/p.jpg',
        fullAssetUrl: 'https://cdn.example.com/f.mp4',
        status: 'live',
        ...over,
      },
    });
  }

  async function lessons(contentId: string, n: number) {
    for (let i = 1; i <= n; i += 1) {
      await prisma.courseLesson.create({
        data: { contentId, title: `Lesson ${i}`, order: i },
      });
    }
  }

  const body = (over: Record<string, unknown> = {}) => ({
    contentType: 'video',
    title: `${PREFIX}teaser ${(seq += 1)}`,
    description: 'A free teaser',
    category: 'business_entrepreneurship',
    accessType: 'free',
    price: 0,
    previewAsset: `https://cdn.example.com/p-${randomUUID()}.jpg`,
    fullAsset: `https://cdn.example.com/f-${randomUUID()}.mp4`,
    ...over,
  });

  const create = (token: string, over: Record<string, unknown> = {}) =>
    request(server())
      .post('/content')
      .set('Authorization', as(token))
      .send(body(over));

  const detail = async (token: string, id: string): Promise<Detail> => {
    const res = await request(server())
      .get(`/content/${id}/detail`)
      .set('Authorization', as(token))
      .expect(200);
    return (res.body as { data: Detail }).data;
  };

  const owned = () =>
    prisma.contentPiece.count({
      where: { title: { startsWith: PREFIX } },
    });

  async function slots(): Promise<number> {
    const s = await prisma.creatorState.findUnique({
      where: { wawuUserId: OWNER },
    });
    return s?.slotsUsed ?? 0;
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ownerToken = await login('creator-pro@test.wawu.dev');
    plainToken = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        ContentPieceModule,
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
    // The owner holds a running tier for this suite (the publishing gate has its own suite).
    for (const wawuUserId of [OWNER, OTHER_CREATOR]) {
      await prisma.makerTier.upsert({
        where: { wawuUserId },
        create: {
          wawuUserId,
          tierId: 'fix111-suite',
          activeFrom: new Date(Date.now() - 86_400_000),
          activeUntil: new Date(Date.now() + 86_400_000 * 30),
          productsIncluded: 25,
          pointsIncluded: 0,
        },
        update: {
          activeUntil: new Date(Date.now() + 86_400_000 * 30),
          productsIncluded: 25,
          extraProducts: 0,
        },
      });
    }
    ownerSlots = await slots();
  }, 30000);

  afterEach(async () => {
    const mine = await prisma.contentPiece.findMany({
      where: { title: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = mine.map((m) => m.id);
    await prisma.contentDetail.deleteMany({
      where: { contentId: { in: ids } },
    });
    await prisma.contentPiece.deleteMany({ where: { id: { in: ids } } });
    await prisma.creatorState.upsert({
      where: { wawuUserId: OWNER },
      create: { wawuUserId: OWNER, slotsUsed: ownerSlots },
      update: { slotsUsed: ownerSlots },
    });
  });

  afterAll(async () => {
    await prisma?.makerTier.deleteMany({
      where: { wawuUserId: { in: [OWNER, OTHER_CREATOR] } },
    });
    await app?.close();
    if (ownedMock && mock) mock.kill();
  });

  it('a creator can send a piece that comes from their own live course, and its page names the course, its lessons and its price', async () => {
    const course = await piece({ price: 8000 });
    await lessons(course.id, 12);
    const res = await create(ownerToken, { parentCourseId: course.id }).expect(
      201,
    );
    const made = (res.body as { data: { id: string } }).data;
    // The piece's own row gains no key: the link is on the side row.
    expect(Object.keys((res.body as { data: object }).data)).not.toContain(
      'parentCourseId',
    );
    await prisma.contentPiece.update({
      where: { id: made.id },
      data: { status: 'live' },
    });
    const seen = await detail(plainToken, made.id);
    expect(seen.parentCourse).toEqual({
      id: course.id,
      title: course.title,
      lessonCount: 12,
      price: 8000,
      previewAssetUrl: expect.any(String) as string,
    });
  });

  it('a free course is named with a price of 0, and a piece that names none says null', async () => {
    const free = await piece({ accessType: 'free', price: 0 });
    await lessons(free.id, 3);
    const a = await create(ownerToken, { parentCourseId: free.id }).expect(201);
    const b = await create(ownerToken).expect(201);
    const ids = [a, b].map((r) => (r.body as { data: { id: string } }).data.id);
    await prisma.contentPiece.updateMany({
      where: { id: { in: ids } },
      data: { status: 'live' },
    });
    expect((await detail(plainToken, ids[0])).parentCourse).toEqual({
      id: free.id,
      title: free.title,
      lessonCount: 3,
      price: 0,
      previewAssetUrl: expect.any(String) as string,
    });
    expect((await detail(plainToken, ids[1])).parentCourse).toBeNull();
    expect(
      await prisma.contentDetail.count({ where: { contentId: ids[1] } }),
    ).toBe(0);
  });

  it('only the creator’s own live or waiting course will do, and nothing is made or counted on a refusal', async () => {
    const theirs = await piece({ creatorWawuId: OTHER_CREATOR });
    const notCourse = await piece({ contentType: 'video' });
    const rejected = await piece({ status: 'rejected' });
    const removed = await piece({ status: 'removed' });
    const before = { pieces: await owned(), slots: await slots() };
    for (const parentCourseId of [
      theirs.id,
      notCourse.id,
      rejected.id,
      removed.id,
      randomUUID(),
    ]) {
      const res = await create(ownerToken, { parentCourseId }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Choose one of your own courses that is live or in review.',
      );
    }
    await create(ownerToken, { parentCourseId: 'not-an-id' }).expect(400);
    const own = await piece();
    const res = await create(ownerToken, {
      contentType: 'course',
      parentCourseId: own.id,
    }).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'A course cannot come from another course.',
    );
    // The five fixtures above and `own` were made by the spec; nothing else was.
    expect(await owned()).toBe(before.pieces + 1);
    expect(await slots()).toBe(before.slots);
  });

  it('the row is left out while the course is in review, turned down or taken down, and comes back when it is live', async () => {
    const course = await piece({ status: 'pending' });
    await lessons(course.id, 2);
    const res = await create(ownerToken, { parentCourseId: course.id }).expect(
      201,
    );
    const id = (res.body as { data: { id: string } }).data.id;
    await prisma.contentPiece.update({
      where: { id },
      data: { status: 'live' },
    });
    expect((await detail(plainToken, id)).parentCourse).toBeNull();
    for (const status of ['rejected', 'removed'] as const) {
      await prisma.contentPiece.update({
        where: { id: course.id },
        data: { status },
      });
      expect((await detail(plainToken, id)).parentCourse).toBeNull();
    }
    await prisma.contentPiece.update({
      where: { id: course.id },
      data: { status: 'live' },
    });
    expect((await detail(plainToken, id)).parentCourse?.lessonCount).toBe(2);
  });

  it('a course that is deleted leaves the piece standing with no row', async () => {
    const course = await piece();
    const res = await create(ownerToken, { parentCourseId: course.id }).expect(
      201,
    );
    const id = (res.body as { data: { id: string } }).data.id;
    await prisma.contentPiece.update({
      where: { id },
      data: { status: 'live' },
    });
    await prisma.contentPiece.delete({ where: { id: course.id } });
    expect((await detail(plainToken, id)).parentCourse).toBeNull();
    const side = await prisma.contentDetail.findUnique({
      where: { contentId: id },
    });
    expect(side?.parentCourseId).toBeNull();
  });

  it('a creator can list only their own courses, for the picker', async () => {
    const course = await piece();
    await piece({ contentType: 'video' });
    await piece({ creatorWawuId: OTHER_CREATOR });
    const res = await request(server())
      .get('/content/mine/library?contentType=course')
      .set('Authorization', as(ownerToken))
      .expect(200);
    const items = (
      res.body as { data: { id: string; contentType: string }[] }
    ).data.filter((i) => i.id === course.id || i.contentType !== 'course');
    expect(items.map((i) => i.id)).toEqual([course.id]);
    const all = (res.body as { data: { contentType: string }[] }).data;
    expect(all.every((i) => i.contentType === 'course')).toBe(true);
    await request(server())
      .get('/content/mine/library?contentType=video')
      .set('Authorization', as(ownerToken))
      .expect(400);
  });
});
