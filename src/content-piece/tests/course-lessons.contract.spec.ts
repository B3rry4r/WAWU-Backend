import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';

// A storage client that never reaches a network: links are signed locally, so a play link can be checked without a bucket.
process.env.STORAGE_ENDPOINT = 'https://storage.lessons-spec.invalid';
process.env.STORAGE_ACCESS_KEY_ID = 'lessons-spec-key';
process.env.STORAGE_SECRET_ACCESS_KEY = 'lessons-spec-secret';
process.env.STORAGE_BUCKET = 'lessons-spec-bucket';
process.env.STORAGE_REGION = 'auto';

import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { isClaimed } from '../../storage/upload-release';
import { ContentPieceModule } from '../content-piece.module';
import { freeLessonCount } from '../course-lessons.service';

/**
 * FIX-107 (H25, G-HOME-08-2, G-121): a course's lessons each have a file; the Hub says who may play which.
 * The first lesson of a course is free, the rest play for the creator and for a person with a completed purchase.
 * Runs against real Postgres and the mock WAWU ID; every row it makes is removed in afterAll.
 */

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

interface Who {
  sub: string;
  token: string;
}

let nonce = 0;
async function register(label: string): Promise<Who> {
  nonce += 1;
  const tag = `${Date.now().toString().slice(-8)}${nonce}`;
  const res = await fetch(`${MOCK_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Lessons Spec ${label}`,
      email: `lessons-spec-${label}-${tag}@test.wawu.dev`,
      phone: `+2347${tag}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`register ${label} failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken };
}

type Lesson = { id: string; hasFile: boolean; isFree: boolean; order: number };

describe('Course lessons: one file each, the first free (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let ownedMock = false;

  let creator: Who;
  let other: Who;
  let buyer: Who;
  let pendingBuyer: Who;
  let stranger: Who;
  let blocked: Who;

  const pieceIds: string[] = [];
  const keys: string[] = [];
  const server = () => app.getHttpServer() as Server;
  const bearer = (w: Who) => `Bearer ${w.token}`;

  const ownKey = (who: Who) => `content/full/${who.sub}/${randomUUID()}.mp4`;
  async function upload(who: Who, key: string, status = 'confirmed') {
    keys.push(key);
    await prisma.storageObject.create({
      data: {
        wawuUserId: who.sub,
        key,
        bytes: 1000,
        contentType: 'video/mp4',
        folder: 'content/full',
        status: status as 'confirmed',
      },
    });
  }

  /** A live course with `files.length` lessons; a true in `files` gives that lesson a file. */
  async function course(
    files: boolean[],
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; lessons: string[] }> {
    const id = randomUUID();
    await prisma.contentPiece.create({
      data: {
        id,
        slug: `lessons-spec-${id}`,
        creatorWawuId: creator.sub,
        contentType: 'course',
        title: 'Lessons spec course',
        description: 'Created by course-lessons.contract.spec.',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 800000,
        previewAssetUrl: 'https://example.com/preview.jpg',
        fullAssetUrl: 'https://example.com/full.mp4',
        status: 'live',
        ...over,
      },
    });
    pieceIds.push(id);
    const lessons: string[] = [];
    for (const [i, has] of files.entries()) {
      const key = has ? ownKey(creator) : null;
      if (key) await upload(creator, key);
      const row = await prisma.courseLesson.create({
        data: {
          contentId: id,
          title: `Lesson ${i + 1}`,
          order: i + 1,
          durationLabel: '10:00',
          assetKey: key,
        },
      });
      lessons.push(row.id);
    }
    return { id, lessons };
  }

  async function buy(who: Who, contentId: string, status = 'completed') {
    await prisma.purchase.create({
      data: {
        contentId,
        type: 'content',
        buyerWawuId: who.sub,
        creatorWawuId: creator.sub,
        amount: 800000,
        commissionRate: 0.15,
        flutterwaveTxRef: `lessons-spec-${randomUUID()}`,
        status: status as 'completed',
      },
    });
  }

  const play = (who: Who, id: string, lessonId: string) =>
    request(server())
      .get(`/content/${id}/lessons/${lessonId}/play`)
      .set('Authorization', bearer(who));
  const setLessons = (who: Who, id: string, lessons: unknown[]) =>
    request(server())
      .put(`/content/${id}/lessons`)
      .set('Authorization', bearer(who))
      .send({ lessons });
  const detailLessons = async (who: Who, id: string): Promise<Lesson[]> => {
    const res = await request(server())
      .get(`/content/${id}/detail`)
      .set('Authorization', bearer(who))
      .expect(200);
    return (res.body as { data: { lessons: Lesson[] } }).data.lessons;
  };

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
    creator = await register('creator');
    other = await register('other');
    buyer = await register('buyer');
    pendingBuyer = await register('pending');
    stranger = await register('stranger');
    blocked = await register('blocked');

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
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);
    for (const who of [creator, other]) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: who.sub,
          accountType: 'creator',
          handle: `lessons_${who.sub.slice(0, 8)}`,
        },
      });
    }
    await prisma.blockedAccount.create({
      data: { userWawuId: creator.sub, blockedWawuId: blocked.sub },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.purchase.deleteMany({
        where: { contentId: { in: pieceIds } },
      });
      await prisma.contentPiece.deleteMany({ where: { id: { in: pieceIds } } });
      await prisma.storageObject.deleteMany({ where: { key: { in: keys } } });
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: creator.sub },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: [creator.sub, other.sub] } },
      });
    }
    await app?.close();
    if (ownedMock) mock?.kill();
  });

  it('the first lesson is free, whatever the creator set, and a one-lesson course has none free', () => {
    expect(freeLessonCount(null, 12)).toBe(1);
    expect(freeLessonCount(0, 12)).toBe(1);
    expect(freeLessonCount(3, 12)).toBe(3);
    expect(freeLessonCount(5, 3)).toBe(2);
    expect(freeLessonCount(null, 1)).toBe(0);
    expect(freeLessonCount(null, 0)).toBe(0);
  });

  it('the page says which lessons are free and which have a file, with nothing else about the file', async () => {
    const c = await course([true, true, false]);
    const lessons = await detailLessons(stranger, c.id);
    expect(lessons.map((l) => [l.order, l.isFree, l.hasFile])).toEqual([
      [1, true, true],
      [2, false, true],
      [3, false, false],
    ]);
    const res = await request(server())
      .get(`/content/${c.id}/detail`)
      .set('Authorization', bearer(stranger));
    expect(JSON.stringify(res.body)).not.toContain('content/full/');
  });

  it('anyone who may open the piece plays the first lesson, with a short-lived signed link to its file', async () => {
    const c = await course([true, true, true]);
    const res = await play(stranger, c.id, c.lessons[0]).expect(200);
    const data = (
      res.body as {
        data: {
          url: string;
          expiresAt: string;
          lessonId: string;
          durationLabel: string;
        };
      }
    ).data;
    expect(data.lessonId).toBe(c.lessons[0]);
    expect(data.durationLabel).toBe('10:00');
    const row = await prisma.courseLesson.findUniqueOrThrow({
      where: { id: c.lessons[0] },
    });
    expect(data.url).toContain(row.assetKey as string);
    expect(data.url).toContain('X-Amz-Signature=');
    expect(data.url).toContain('X-Amz-Expires=3600');
    const left = new Date(data.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(3500 * 1000);
    expect(left).toBeLessThanOrEqual(3600 * 1000);
  });

  it('a lesson after the first is refused to a stranger and to a person whose payment did not finish, with no link', async () => {
    const c = await course([true, true, true]);
    await buy(pendingBuyer, c.id, 'pending');
    for (const who of [stranger, pendingBuyer]) {
      const res = await play(who, c.id, c.lessons[1]).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Unlock the course to watch this lesson.',
      );
      expect(JSON.stringify(res.body)).not.toContain('X-Amz');
    }
  });

  it('a buyer and the creator play every lesson', async () => {
    const c = await course([true, true, true]);
    await buy(buyer, c.id);
    for (const who of [buyer, creator]) {
      for (const lesson of c.lessons) await play(who, c.id, lesson).expect(200);
    }
  });

  it('the creator opening more lessons for everyone is honoured', async () => {
    const c = await course([true, true, true, true]);
    await request(server())
      .put(`/content/${c.id}/preview`)
      .set('Authorization', bearer(creator))
      .send({ freeLessons: 2 })
      .expect(200);
    await play(stranger, c.id, c.lessons[1]).expect(200);
    await play(stranger, c.id, c.lessons[2]).expect(403);
    const lessons = await detailLessons(stranger, c.id);
    expect(lessons.map((l) => l.isFree)).toEqual([true, true, false, false]);
  });

  it('a course of one lesson is not free to play, and free content plays every lesson', async () => {
    const one = await course([true]);
    await play(stranger, one.id, one.lessons[0]).expect(403);
    const free = await course([true, true], { accessType: 'free', price: 0 });
    await play(stranger, free.id, free.lessons[1]).expect(200);
  });

  it('a lesson with no file answers that it has no video, to someone who may play it', async () => {
    const c = await course([false, true]);
    const res = await play(stranger, c.id, c.lessons[0]).expect(404);
    expect((res.body as { message: string }).message).toBe(
      'This lesson has no video yet.',
    );
  });

  it('a lesson of another piece, a piece that is not a course, a hidden piece and a blocked viewer all answer not found', async () => {
    const a = await course([true, true]);
    const b = await course([true, true]);
    await play(stranger, a.id, b.lessons[0]).expect(404);
    await play(stranger, a.id, randomUUID()).expect(404);
    const pdf = await course([], { contentType: 'pdf' });
    await play(stranger, pdf.id, a.lessons[0]).expect(404);
    const draft = await course([true, true], { status: 'pending' });
    await play(stranger, draft.id, draft.lessons[0]).expect(404);
    await play(blocked, a.id, a.lessons[0]).expect(404);
  });

  describe('PUT /content/:id/lessons', () => {
    it('the creator states the lessons with their files, and the order is the order sent', async () => {
      const c = await course([]);
      const k1 = ownKey(creator);
      const k2 = ownKey(creator);
      await upload(creator, k1);
      await upload(creator, k2);
      const res = await setLessons(creator, c.id, [
        { title: 'Welcome', durationLabel: '3:10', assetKey: k1 },
        { title: 'The first job', assetKey: k2 },
        { title: 'Coming soon' },
      ]).expect(200);
      const got = (
        res.body as {
          data: {
            lessons: Array<{ order: number; title: string; hasFile: boolean }>;
          };
        }
      ).data.lessons;
      expect(got.map((l) => [l.order, l.title, l.hasFile])).toEqual([
        [1, 'Welcome', true],
        [2, 'The first job', true],
        [3, 'Coming soon', false],
      ]);
      const rows = await prisma.courseLesson.findMany({
        where: { contentId: c.id },
        orderBy: { order: 'asc' },
      });
      expect(rows.map((r) => r.assetKey)).toEqual([k1, k2, null]);
      expect(await isClaimed(prisma, k1)).toBe(true);
    });

    it('keeping a lesson by id keeps its progress and new order; a lesson left out goes when nobody has bought', async () => {
      const c = await course([true, true, true]);
      await prisma.courseLessonProgress.create({
        data: {
          userWawuId: stranger.sub,
          lessonId: c.lessons[2],
          contentId: c.id,
        },
      });
      const res = await setLessons(creator, c.id, [
        { id: c.lessons[2], title: 'Now first' },
        { id: c.lessons[0], title: 'Now second' },
      ]).expect(200);
      const got = (res.body as { data: { lessons: Array<{ id: string }> } })
        .data.lessons;
      expect(got.map((l) => l.id)).toEqual([c.lessons[2], c.lessons[0]]);
      expect(
        await prisma.courseLesson.count({ where: { contentId: c.id } }),
      ).toBe(2);
      expect(
        await prisma.courseLessonProgress.count({
          where: { lessonId: c.lessons[2] },
        }),
      ).toBe(1);
    });

    it('FIX-111: a lesson kept by id keeps its file when none is sent, takes a new file when one is, and loses it only for null', async () => {
      const c = await course([true, true, true]);
      const before = await prisma.courseLesson.findMany({
        where: { contentId: c.id },
        orderBy: { order: 'asc' },
      });
      const fresh = ownKey(creator);
      await upload(creator, fresh);
      // Reordered and renamed with no key sent: every file stays with its lesson.
      await setLessons(creator, c.id, [
        { id: c.lessons[2], title: 'Third, now first' },
        { id: c.lessons[0], title: 'First, now second', assetKey: fresh },
        { id: c.lessons[1], title: 'Second, now last', assetKey: null },
        { title: 'A new lesson, no file yet' },
      ]).expect(200);
      const rows = await prisma.courseLesson.findMany({
        where: { contentId: c.id },
        orderBy: { order: 'asc' },
      });
      expect(rows.map((r) => r.title)).toEqual([
        'Third, now first',
        'First, now second',
        'Second, now last',
        'A new lesson, no file yet',
      ]);
      expect(rows.map((r) => r.assetKey)).toEqual([
        before[2].assetKey,
        fresh,
        null,
        null,
      ]);
      const kept = await detailLessons(creator, c.id);
      expect(kept.map((l) => l.hasFile)).toEqual([true, true, false, false]);
      // Sent once more with no key at all: the files of the kept lessons stay.
      await setLessons(
        creator,
        c.id,
        rows.map((r) => ({ id: r.id, title: r.title })),
      ).expect(200);
      const again = await prisma.courseLesson.findMany({
        where: { contentId: c.id },
        orderBy: { order: 'asc' },
      });
      expect(again.map((r) => r.assetKey)).toEqual(rows.map((r) => r.assetKey));
    });

    it('a course people have bought never loses a lesson', async () => {
      const c = await course([true, true]);
      await buy(buyer, c.id);
      await setLessons(creator, c.id, [
        { id: c.lessons[0], title: 'Only' },
      ]).expect(409);
      expect(
        await prisma.courseLesson.count({ where: { contentId: c.id } }),
      ).toBe(2);
      await setLessons(creator, c.id, [
        { id: c.lessons[1], title: 'Swapped' },
        { id: c.lessons[0], title: 'Swapped back' },
      ]).expect(200);
    });

    it('only the creator of a course sets its lessons, and only a course has them', async () => {
      const c = await course([true, true]);
      await setLessons(other, c.id, [{ title: 'Mine now' }]).expect(403);
      await setLessons(stranger, c.id, [{ title: 'Mine now' }]).expect(403);
      const pdf = await course([], { contentType: 'pdf' });
      await setLessons(creator, pdf.id, [{ title: 'No' }]).expect(400);
      expect(
        await prisma.courseLesson.count({ where: { contentId: c.id } }),
      ).toBe(2);
    });

    it('a file must be a full-folder upload of the creator that they still hold', async () => {
      const c = await course([]);
      const theirs = ownKey(other);
      await upload(other, theirs);
      const never = ownKey(creator);
      const abandoned = ownKey(creator);
      await upload(creator, abandoned, 'abandoned');
      const preview = `content/preview/${creator.sub}/${randomUUID()}.mp4`;
      await upload(creator, preview);
      for (const bad of [
        theirs,
        never,
        abandoned,
        preview,
        '../x',
        'https://example.com/a.mp4',
      ]) {
        await setLessons(creator, c.id, [
          { title: 'Bad', assetKey: bad },
        ]).expect(400);
      }
      expect(
        await prisma.courseLesson.count({ where: { contentId: c.id } }),
      ).toBe(0);
    });

    it('an id that is not a lesson of this course, a lesson listed twice, an empty list and too many lessons are refused', async () => {
      const a = await course([true]);
      const b = await course([true]);
      await setLessons(creator, a.id, [
        { id: b.lessons[0], title: 'x' },
      ]).expect(400);
      await setLessons(creator, a.id, [
        { id: a.lessons[0], title: 'x' },
        { id: a.lessons[0], title: 'y' },
      ]).expect(400);
      await setLessons(creator, a.id, []).expect(400);
      await setLessons(
        creator,
        a.id,
        Array.from({ length: 61 }, (_, i) => ({ title: `L${i}` })),
      ).expect(400);
      await setLessons(creator, a.id, [
        { title: 'x', durationLabel: 'long' },
      ]).expect(400);
      expect(
        await prisma.courseLesson.count({ where: { contentId: a.id } }),
      ).toBe(1);
    });
  });
});
