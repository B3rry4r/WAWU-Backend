import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import type { Server } from 'http';
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
 * HOME-06: content detail. A user can see how much of a piece is free, the
 * real counts, and rate it fairly (H19, H23, H25).
 *
 * Runs against real Postgres and the mock WAWU ID. Every identity here is
 * registered fresh with random ids and every piece is created with a random
 * id; both are removed in afterAll (pieces cascade their ratings, details and
 * lessons; purchases are removed first because they restrict the delete).
 * The one seeded account used is creator-pro, for the edit that moves
 * "updated at".
 */

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;
const SEEDED_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

/** The keys GET /content/:id and GET /content have always returned (protected registry, GET /content/:id). */
const LIVE_PIECE_KEYS = [
  'accessType',
  'category',
  'commentCount',
  'contentType',
  'createdAt',
  'creatorFirstUploadFree',
  'creatorWawuId',
  'description',
  'durationLabel',
  'fullAssetLocked',
  'fullAssetUrl',
  'id',
  'likes',
  'pageCount',
  'previewAssetUrl',
  'price',
  'ratingPct',
  'slug',
  'specializations',
  'status',
  'tags',
  'title',
  'views',
];

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
      fullName: `Detail Spec ${label}`,
      email: `detail-spec-${label}-${tag}@test.wawu.dev`,
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

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Content detail: previews, fair ratings, counts (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let ownedMock = false;

  let creator: Who;
  let creator2: Who;
  let buyer: Who;
  let buyer2: Who;
  let stranger: Who;
  let blockedByCreator: Who;
  let blocksCreator: Who;
  let proToken: string;

  const pieceIds: string[] = [];
  let seq = 0;

  const server = () => app.getHttpServer() as Server;
  const bearer = (w: { token: string } | string) =>
    `Bearer ${typeof w === 'string' ? w : w.token}`;

  async function piece(
    over: Record<string, unknown> = {},
    by: string = creator.sub,
  ): Promise<string> {
    seq += 1;
    const id = randomUUID();
    await prisma.contentPiece.create({
      data: {
        id,
        slug: `detail-spec-${id}`,
        creatorWawuId: by,
        contentType: 'pdf',
        title: `Detail spec ${seq}`,
        description: 'Created by content-detail.contract.spec.',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 300000,
        pageCount: 84,
        previewAssetUrl: 'https://example.com/preview.pdf',
        fullAssetUrl: 'https://example.com/full.pdf',
        status: 'live',
        ...over,
      },
    });
    pieceIds.push(id);
    return id;
  }

  async function buy(
    who: Who,
    contentId: string,
    status: 'completed' | 'pending' | 'failed' = 'completed',
    creatorId: string = creator.sub,
    purchasedAt?: Date,
  ) {
    await prisma.purchase.create({
      data: {
        contentId,
        type: 'content',
        buyerWawuId: who.sub,
        creatorWawuId: creatorId,
        amount: 300000,
        commissionRate: 0.15,
        flutterwaveTxRef: `detail-spec-${randomUUID()}`,
        status,
        ...(purchasedAt ? { purchasedAt } : {}),
      },
    });
  }

  const rate = (
    who: Who,
    id: string,
    stars: unknown,
    route: 'put' | 'post' = 'put',
  ) =>
    route === 'put'
      ? request(server())
          .put(`/content/${id}/rating`)
          .set('Authorization', bearer(who))
          .send({ rating: stars })
      : request(server())
          .post(`/content/${id}/rate`)
          .set('Authorization', bearer(who))
          .send({ rating: stars });

  const detail = (who: Who | string, id: string) =>
    request(server())
      .get(`/content/${id}/detail`)
      .set('Authorization', bearer(who));

  const setPreview = (who: Who, id: string, body: Record<string, unknown>) =>
    request(server())
      .put(`/content/${id}/preview`)
      .set('Authorization', bearer(who))
      .send(body);

  const stored = (id: string) =>
    prisma.contentPiece.findUniqueOrThrow({
      where: { id },
      select: { ratingPct: true },
    });

  const ratingRows = (id: string) =>
    prisma.contentRating.findMany({ where: { contentId: id } });

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
    creator2 = await register('creator2');
    buyer = await register('buyer');
    buyer2 = await register('buyer2');
    stranger = await register('stranger');
    blockedByCreator = await register('blockedbycreator');
    blocksCreator = await register('blockscreator');
    proToken = await login('creator-pro@test.wawu.dev');

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
  });

  afterAll(async () => {
    if (prisma && pieceIds.length > 0) {
      await prisma.purchase.deleteMany({
        where: { contentId: { in: pieceIds } },
      });
      await prisma.contentPiece.deleteMany({ where: { id: { in: pieceIds } } });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [
            { userWawuId: { in: [creator.sub, blockedByCreator.sub] } },
            { blockedWawuId: { in: [creator.sub, blockedByCreator.sub] } },
          ],
        },
      });
    }
    await app?.close();
    if (ownedMock) mock?.kill();
  });

  describe('ratings', () => {
    it('a user who did not buy a paid piece cannot rate it', async () => {
      const id = await piece();
      await buy(buyer2, id, 'pending'); // an unfinished payment is not a purchase
      await buy(buyer2, id, 'failed');

      for (const who of [stranger, buyer2]) {
        const res = await rate(who, id, 5).expect(403);
        expect((res.body as { message: string }).message).toBe(
          'Only people who bought this can rate it.',
        );
      }
      // The old route enforces the same rule.
      await rate(stranger, id, 5, 'post').expect(403);

      expect(await ratingRows(id)).toHaveLength(0);
      expect((await stored(id)).ratingPct).toBeNull();
      const d = await detail(stranger, id).expect(200);
      const r = (d.body as { data: { rating: Record<string, unknown> } }).data
        .rating;
      expect(r).toMatchObject({
        count: 0,
        average: null,
        myRating: null,
        canRate: false,
        cannotRateReason: 'not_purchased',
      });
    });

    it('a buyer can rate a paid piece and sees the average, the count and their own stars', async () => {
      const id = await piece();
      await buy(buyer, id);

      const res = await rate(buyer, id, 4).expect(200);
      expect((res.body as { data: unknown }).data).toEqual({
        average: 4,
        count: 1,
        myRating: 4,
        canRate: true,
        cannotRateReason: null,
      });
      expect((await stored(id)).ratingPct).toBe(80);
    });

    it('a buyer rating twice updates their rating, it does not add a second one', async () => {
      const id = await piece();
      await buy(buyer, id);

      await rate(buyer, id, 5).expect(200);
      const res = await rate(buyer, id, 2).expect(200);
      const state = (res.body as { data: Record<string, unknown> }).data;
      expect(state).toMatchObject({ count: 1, average: 2, myRating: 2 });

      const rows = await ratingRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].stars).toBe(2);
      expect((await stored(id)).ratingPct).toBe(40);

      // The web's own call lands on the same row.
      await rate(buyer, id, 3, 'post').expect(201);
      expect(await ratingRows(id)).toHaveLength(1);
      expect((await ratingRows(id))[0].stars).toBe(3);
    });

    it("the average is worked out from every buyer's row, never from what the last request said", async () => {
      const id = await piece();
      await buy(buyer, id);
      await buy(buyer2, id);

      await rate(buyer, id, 5).expect(200);
      await rate(buyer2, id, 2).expect(200);
      const d = await detail(buyer, id).expect(200);
      expect(
        (d.body as { data: { rating: Record<string, unknown> } }).data.rating,
      ).toMatchObject({ average: 3.5, count: 2, myRating: 5 });
      expect((await stored(id)).ratingPct).toBe(70);

      // Changing one rating moves the average by that person's change only.
      await rate(buyer2, id, 4).expect(200);
      expect((await stored(id)).ratingPct).toBe(90);
    });

    it('a creator cannot rate their own piece', async () => {
      const id = await piece({ accessType: 'free', price: 0 });
      const res = await rate(creator, id, 5).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'You cannot rate your own content.',
      );
      expect(await ratingRows(id)).toHaveLength(0);
    });

    it('a user can rate a free piece once, and cannot rate one that is not live', async () => {
      const free = await piece({ accessType: 'free', price: 0 });
      await rate(stranger, free, 3).expect(200);
      await rate(stranger, free, 5).expect(200);
      expect(await ratingRows(free)).toHaveLength(1);

      const pending = await piece({ status: 'pending' });
      await buy(buyer, pending);
      await rate(buyer, pending, 5).expect(404);
      const removed = await piece({ status: 'removed' });
      await rate(buyer, removed, 5).expect(404);
    });

    it('a user cannot store anything but 1 to 5 stars', async () => {
      const id = await piece({ accessType: 'free', price: 0 });
      for (const bad of [0, 6, 3.5, '5', null, -1]) {
        await rate(stranger, id, bad).expect(400);
      }
      expect(await ratingRows(id)).toHaveLength(0);
      // And the database refuses it too, so no code path can write one.
      await expect(
        prisma.contentRating.create({
          data: { userWawuId: stranger.sub, contentId: id, stars: 9 },
        }),
      ).rejects.toThrow();
    });

    it('a rating from the web for a missing piece is a 404', async () => {
      await rate(buyer, randomUUID(), 5).expect(404);
      await rate(buyer, randomUUID(), 5, 'post').expect(404);
    });

    it('twelve buyers rating at the same moment each get exactly one row and the average is right', async () => {
      const id = await piece();
      const crowd: Who[] = [];
      for (let i = 0; i < 12; i += 1) crowd.push(await register(`crowd${i}`));
      await Promise.all(crowd.map((w) => buy(w, id)));

      const stars = crowd.map((_, i) => (i % 5) + 1);
      const results = await Promise.all(
        crowd.map((w, i) => rate(w, id, stars[i])),
      );
      expect(results.map((r) => r.status)).toEqual(crowd.map(() => 200));

      const rows = await ratingRows(id);
      expect(rows).toHaveLength(12);
      const mean = stars.reduce((a, b) => a + b, 0) / stars.length;
      expect((await stored(id)).ratingPct).toBe(Math.round(mean * 20));
      const d = await detail(crowd[0], id).expect(200);
      expect(
        (d.body as { data: { rating: { count: number; average: number } } })
          .data.rating,
      ).toMatchObject({
        count: 12,
        average: Math.round(mean * 10) / 10,
      });
    });

    it('one buyer tapping twelve times at once leaves one row, and the cache matches the row that won', async () => {
      const id = await piece();
      await buy(buyer, id);
      const taps = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 5];
      const results = await Promise.all(taps.map((s) => rate(buyer, id, s)));
      expect(results.map((r) => r.status)).toEqual(taps.map(() => 200));

      const rows = await ratingRows(id);
      expect(rows).toHaveLength(1);
      expect((await stored(id)).ratingPct).toBe(rows[0].stars * 20);
    });

    it('twelve people changing and adding ratings together never leave a stale average', async () => {
      const id = await piece();
      const crowd: Who[] = [];
      for (let i = 0; i < 6; i += 1) crowd.push(await register(`mix${i}`));
      await Promise.all(crowd.map((w) => buy(w, id)));
      // Two rounds at once from the same six people: 12 requests, 6 rows.
      await Promise.all([
        ...crowd.map((w, i) => rate(w, id, (i % 5) + 1)),
        ...crowd.map((w, i) => rate(w, id, 5 - (i % 5))),
      ]);
      const rows = await ratingRows(id);
      expect(rows).toHaveLength(6);
      const mean = rows.reduce((a, r) => a + r.stars, 0) / rows.length;
      expect((await stored(id)).ratingPct).toBe(Math.round(mean * 20));
    });
  });

  describe('blocked people', () => {
    it('a user blocked by the creator, or who blocked the creator, gets the same 404 as a missing piece on every new route', async () => {
      const id = await piece({ accessType: 'free', price: 0 });
      await prisma.blockedAccount.createMany({
        data: [
          { userWawuId: creator.sub, blockedWawuId: blockedByCreator.sub },
          { userWawuId: blocksCreator.sub, blockedWawuId: creator.sub },
        ],
      });

      const missing = randomUUID();
      const missingRate = await rate(stranger, missing, 5).expect(404);
      const missingDetail = await detail(stranger, missing).expect(404);
      const missingPreview = await setPreview(stranger, missing, {}).expect(
        404,
      );

      for (const who of [blockedByCreator, blocksCreator]) {
        const r = await rate(who, id, 5).expect(404);
        expect((r.body as { message: string }).message).toBe(
          (missingRate.body as { message: string }).message,
        );
        const d = await detail(who, id).expect(404);
        expect((d.body as { message: string }).message).toBe(
          (missingDetail.body as { message: string }).message,
        );
        const p = await setPreview(who, id, {}).expect(404);
        expect((p.body as { message: string }).message).toBe(
          (missingPreview.body as { message: string }).message,
        );
        await rate(who, id, 5, 'post').expect(404);
      }
      expect(await ratingRows(id)).toHaveLength(0);

      // A person who is not blocked is unaffected.
      await rate(stranger, id, 5).expect(200);
    });

    it('a buyer keeps the detail of what they bought after a block, but cannot rate it', async () => {
      const id = await piece();
      await buy(blockedByCreator, id);
      await prisma.blockedAccount.upsert({
        where: {
          userWawuId_blockedWawuId: {
            userWawuId: creator.sub,
            blockedWawuId: blockedByCreator.sub,
          },
        },
        create: {
          userWawuId: creator.sub,
          blockedWawuId: blockedByCreator.sub,
        },
        update: {},
      });
      const d = await detail(blockedByCreator, id).expect(200);
      expect(
        (d.body as { data: { purchasedAt: string | null } }).data.purchasedAt,
      ).not.toBeNull();
      await rate(blockedByCreator, id, 5).expect(404);
    });
  });

  describe('free previews', () => {
    it('a creator can set how many pages of their paid pdf are free, and everyone sees it', async () => {
      const id = await piece();
      const res = await setPreview(creator, id, { freePages: 4 }).expect(200);
      expect((res.body as { data: unknown }).data).toEqual({
        pages: 4,
        seconds: null,
        lessons: null,
      });
      const seen = await detail(stranger, id).expect(200);
      expect(
        (seen.body as { data: { freePreview: unknown } }).data.freePreview,
      ).toEqual({ pages: 4, seconds: null, lessons: null });
    });

    it('a creator can set free seconds on a video and free lessons on a course', async () => {
      const video = await piece({ contentType: 'video', pageCount: null });
      await setPreview(creator, video, { freeSeconds: 45 }).expect(200);
      const v = await detail(stranger, video).expect(200);
      expect(
        (v.body as { data: { freePreview: { seconds: number } } }).data
          .freePreview.seconds,
      ).toBe(45);

      const course = await piece({ contentType: 'course', pageCount: null });
      await prisma.courseLesson.createMany({
        data: [1, 2, 3, 4].map((order) => ({
          contentId: course,
          title: `Lesson ${order}`,
          order,
          durationLabel: '10 min',
        })),
      });
      await setPreview(creator, course, { freeLessons: 2 }).expect(200);
      const c = await detail(stranger, course).expect(200);
      const lessons = (
        c.body as {
          data: { lessons: Array<{ order: number; isFree: boolean }> };
        }
      ).data.lessons;
      expect(lessons.map((l) => [l.order, l.isFree])).toEqual([
        [1, true],
        [2, true],
        [3, false],
        [4, false],
      ]);
    });

    it('nobody but the creator can change a preview, and the answer is the 404 a missing piece gives', async () => {
      const id = await piece();
      await setPreview(creator2, id, { freePages: 4 }).expect(404);
      await setPreview(buyer, id, { freePages: 4 }).expect(404);
      expect(
        await prisma.contentDetail.findUnique({ where: { contentId: id } }),
      ).toBeNull();
    });

    it('a creator cannot declare a preview that is the whole piece, the wrong kind, or on free content', async () => {
      const pdf = await piece();
      await setPreview(creator, pdf, { freePages: 84 }).expect(400);
      await setPreview(creator, pdf, { freePages: 200 }).expect(400);
      await setPreview(creator, pdf, { freeSeconds: 30 }).expect(400);
      await setPreview(creator, pdf, { freePages: 0 }).expect(400);
      await setPreview(creator, pdf, { freePages: 2.5 }).expect(400);
      const free = await piece({ accessType: 'free', price: 0 });
      await setPreview(creator, free, { freePages: 4 }).expect(400);
      const image = await piece({ contentType: 'image', pageCount: null });
      await setPreview(creator, image, { freePages: 1 }).expect(400);
      const course = await piece({ contentType: 'course', pageCount: null });
      await prisma.courseLesson.create({
        data: { contentId: course, title: 'Only one', order: 1 },
      });
      await setPreview(creator, course, { freeLessons: 1 }).expect(400);
      expect(
        await prisma.contentDetail.count({
          where: { contentId: { in: [pdf, free, image, course] } },
        }),
      ).toBe(0);
    });

    it('a creator can clear a preview by sending nothing', async () => {
      const id = await piece();
      await setPreview(creator, id, { freePages: 3 }).expect(200);
      const res = await setPreview(creator, id, {}).expect(200);
      expect((res.body as { data: unknown }).data).toEqual({
        pages: null,
        seconds: null,
        lessons: null,
      });
    });

    it('a piece with no preview set says so with nulls, never a guessed number', async () => {
      const id = await piece();
      const d = await detail(stranger, id).expect(200);
      expect(
        (d.body as { data: { freePreview: unknown } }).data.freePreview,
      ).toEqual({ pages: null, seconds: null, lessons: null });
    });
  });

  describe('counts and dates', () => {
    it('a user sees how many people bought a piece, counting only finished payments and each person once', async () => {
      const id = await piece();
      await buy(buyer, id);
      await buy(buyer, id); // a second completed row for the same person
      await buy(buyer2, id);
      await buy(stranger, id, 'pending');
      await buy(blocksCreator, id, 'failed');

      const d = await detail(stranger, id).expect(200);
      const data = (
        d.body as {
          data: { buyerCount: number; studentCount: number | null };
        }
      ).data;
      expect(data.buyerCount).toBe(2);
      expect(data.studentCount).toBeNull(); // a pdf has buyers, not students
    });

    it('a user sees the student count of a paid course, and none for a free one', async () => {
      const course = await piece({ contentType: 'course', pageCount: null });
      await buy(buyer, course);
      await buy(buyer2, course);
      const d = await detail(stranger, course).expect(200);
      expect(
        (d.body as { data: { studentCount: number } }).data.studentCount,
      ).toBe(2);

      const free = await piece({
        contentType: 'course',
        pageCount: null,
        accessType: 'free',
        price: 0,
      });
      const f = await detail(stranger, free).expect(200);
      expect(
        (f.body as { data: { studentCount: unknown } }).data.studentCount,
      ).toBeNull();
    });

    it('a buyer sees when they bought it and nobody else sees that date', async () => {
      const id = await piece();
      const when = new Date('2026-09-26T10:00:00.000Z');
      await buy(buyer, id, 'completed', creator.sub, when);
      const mine = await detail(buyer, id).expect(200);
      expect(
        (mine.body as { data: { purchasedAt: string } }).data.purchasedAt,
      ).toBe(when.toISOString());
      const theirs = await detail(stranger, id).expect(200);
      expect(
        (theirs.body as { data: { purchasedAt: unknown } }).data.purchasedAt,
      ).toBeNull();
    });

    it('a user sees when a piece was made, and the date moves when the creator edits it', async () => {
      const made = new Date('2026-08-01T09:00:00.000Z');
      const id = await piece(
        { status: 'pending', createdAt: made },
        SEEDED_CREATOR_PRO,
      );
      const before = await detail(stranger, id).expect(404); // pending: not public
      expect(before.status).toBe(404);
      const own = await detail(proToken, id).expect(200);
      expect((own.body as { data: { updatedAt: string } }).data.updatedAt).toBe(
        made.toISOString(),
      );

      await request(server())
        .patch(`/content/${id}`)
        .set('Authorization', bearer(proToken))
        .send({ title: 'Edited by the creator' })
        .expect(200);
      const after = await detail(proToken, id).expect(200);
      const updated = new Date(
        (after.body as { data: { updatedAt: string } }).data.updatedAt,
      );
      expect(updated.getTime()).toBeGreaterThan(made.getTime());
      expect(Date.now() - updated.getTime()).toBeLessThan(60_000);
    });

    it('a user gets the 404 a missing piece gives for one that is removed or not live', async () => {
      await detail(stranger, randomUUID()).expect(404);
      await detail(stranger, await piece({ status: 'removed' })).expect(404);
      await detail(stranger, await piece({ status: 'rejected' })).expect(404);
    });

    it('a user cannot reach the detail without signing in', async () => {
      const id = await piece();
      await request(server()).get(`/content/${id}/detail`).expect(401);
      await request(server())
        .put(`/content/${id}/rating`)
        .send({ rating: 5 })
        .expect(401);
      await request(server())
        .put(`/content/${id}/preview`)
        .send({})
        .expect(401);
    });
  });

  describe('what already lives does not change', () => {
    it('GET /content/:id and GET /content return exactly the keys they always did, after previews and ratings exist', async () => {
      const id = await piece();
      await buy(buyer, id);
      await setPreview(creator, id, { freePages: 4 }).expect(200);
      await rate(buyer, id, 5).expect(200);

      const one = await request(server())
        .get(`/content/${id}`)
        .set('Authorization', bearer(buyer))
        .expect(200);
      const data = (one.body as { data: Record<string, unknown> }).data;
      expect(Object.keys(data).sort()).toEqual([...LIVE_PIECE_KEYS].sort());
      expect(data.ratingPct).toBe(100);

      const list = await request(server())
        .get('/content?perPage=5')
        .set('Authorization', bearer(buyer))
        .expect(200);
      const items = (list.body as { data: Array<Record<string, unknown>> })
        .data;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([...LIVE_PIECE_KEYS].sort());
      }
    });
  });
});
