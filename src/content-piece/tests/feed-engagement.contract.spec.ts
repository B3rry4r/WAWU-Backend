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
 * HOME-04: the Following tab, likes, views, shares and the per-viewer flags.
 *
 * Every identity and every piece here is created by this spec with random ids
 * and deleted in afterAll, so no seeded row (and no other spec's count) is
 * touched. Pieces cascade-delete their likes, views and shares.
 */

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

type Row = Record<string, unknown> & { id: string };
interface Reply {
  /** The envelope's `data` when it is an object. */
  data: Record<string, unknown>;
  /** The envelope's `data` when it is a list (a feed page). */
  list: Row[];
  /** `pagination.total` on a list. */
  total: number;
}

let nonceCounter = 0;
async function registerIdentity(
  label: string,
): Promise<{ sub: string; token: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceCounter += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Feed Spec ${label}`,
      email: `feed-spec-${label}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
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

describe('Feed, likes, views and shares (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMock = false;

  let fan: { sub: string; token: string };
  let otherFan: { sub: string; token: string };
  let loner: { sub: string; token: string };
  let creatorA: { sub: string; token: string };
  let creatorB: { sub: string; token: string };

  const pieceIds: string[] = [];
  let aLive: string;
  let aSecondLive: string;
  let aPending: string;
  let aRemoved: string;
  let bLive: string;

  const auth = (t: { token: string }) => ({
    Authorization: `Bearer ${t.token}`,
  });

  /** One call, asserting the status, with the envelope typed. */
  async function send(
    method: 'get' | 'post' | 'delete',
    url: string,
    who: { token: string } | undefined,
    status = 200,
  ): Promise<Reply> {
    let req = request(app.getHttpServer() as Server)[method](url);
    if (who) req = req.set(auth(who));
    const res = await req.expect(status);
    const body = res.body as {
      data?: unknown;
      pagination?: { total: number };
    };
    return {
      data: Array.isArray(body.data)
        ? {}
        : ((body.data ?? {}) as Record<string, unknown>),
      list: Array.isArray(body.data) ? (body.data as Row[]) : [],
      total: body.pagination?.total ?? 0,
    };
  }

  async function makePiece(
    creatorWawuId: string,
    status: 'live' | 'pending' | 'removed',
    createdAt?: Date,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.contentPiece.create({
      data: {
        id,
        slug: `feed-spec-${id}`,
        creatorWawuId,
        contentType: 'pdf',
        title: `Feed spec ${status}`,
        description: 'Created by feed-engagement.contract.spec.',
        category: 'business_entrepreneurship',
        accessType: 'free',
        price: 0,
        previewAssetUrl: 'https://example.com/preview.pdf',
        fullAssetUrl: 'https://example.com/full.pdf',
        status,
        likes: 0,
        views: 0,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    pieceIds.push(id);
    return id;
  }

  const counters = (id: string) =>
    prisma.contentPiece.findUniqueOrThrow({
      where: { id },
      select: { likes: true, views: true },
    });

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    fan = await registerIdentity('fan');
    otherFan = await registerIdentity('otherfan');
    loner = await registerIdentity('loner');
    creatorA = await registerIdentity('creatora');
    creatorB = await registerIdentity('creatorb');

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

    const now = Date.now();
    aLive = await makePiece(creatorA.sub, 'live', new Date(now - 60_000));
    aSecondLive = await makePiece(creatorA.sub, 'live', new Date(now - 30_000));
    aPending = await makePiece(creatorA.sub, 'pending');
    aRemoved = await makePiece(creatorA.sub, 'removed');
    bLive = await makePiece(creatorB.sub, 'live');

    // `fan` follows creator A only. `otherFan` follows nobody.
    await prisma.followRelationship.create({
      data: { followerWawuId: fan.sub, followingWawuId: creatorA.sub },
    });
  });

  afterAll(async () => {
    const people = [fan, otherFan, loner, creatorA, creatorB].map((p) => p.sub);
    await prisma.savedItem.deleteMany({
      where: { contentId: { in: pieceIds } },
    });
    await prisma.followRelationship.deleteMany({
      where: {
        OR: [
          { followerWawuId: { in: people } },
          { followingWawuId: { in: people } },
        ],
      },
    });
    await prisma.contentPiece.deleteMany({ where: { id: { in: pieceIds } } });
    await app?.close();
    if (ownedMock && mockWawuId) mockWawuId.kill();
  });

  describe('Following tab', () => {
    it('a user sees only live pieces by people they follow, newest first', async () => {
      const res = await send(
        'get',
        '/feed?scope=following&perPage=100',
        fan,
        200,
      );

      const ids = res.list.map((i) => i.id);
      expect(ids).toEqual([aSecondLive, aLive]);
      expect(ids).not.toContain(bLive);
      expect(ids).not.toContain(aPending);
      expect(ids).not.toContain(aRemoved);
      expect(res.total).toBe(2);
    });

    it('a user who follows nobody sees an empty Following tab and a count of zero', async () => {
      const feed = await send('get', '/feed?scope=following', loner, 200);
      expect(feed.list).toEqual([]);
      expect(feed.total).toBe(0);

      const count = await send('get', '/feed/following/count', loner, 200);
      expect(count.data).toEqual({ count: 0 });
    });

    it('a user who unfollows a creator stops seeing that creator in Following', async () => {
      await prisma.followRelationship.create({
        data: { followerWawuId: otherFan.sub, followingWawuId: creatorB.sub },
      });
      const before = await send('get', '/feed?scope=following', otherFan, 200);
      expect(before.list.map((i) => i.id)).toEqual([bLive]);
      const count = await send('get', '/feed/following/count', otherFan, 200);
      expect(count.data).toEqual({ count: 1 });

      await prisma.followRelationship.deleteMany({
        where: { followerWawuId: otherFan.sub },
      });
      const after = await send('get', '/feed?scope=following', otherFan, 200);
      expect(after.list).toEqual([]);
    });

    it('the For you tab still shows pieces by people the user does not follow', async () => {
      const res = await send(
        'get',
        '/feed?scope=for_you&sort=recent&perPage=100',
        fan,
        200,
      );
      const ids = res.list.map((i) => i.id);
      expect(ids).toContain(bLive);
      expect(ids).toContain(aLive);
      expect(ids).not.toContain(aPending);
    });

    it('a user can also ask GET /content for the Following scope, in the same shape as before', async () => {
      const res = await send(
        'get',
        '/content?scope=following&perPage=100',
        fan,
        200,
      );
      const items = res.list;
      expect(items.map((i) => i.id)).toEqual([aSecondLive, aLive]);
      // GET /content keeps its shape: the viewer flags live on /feed only.
      expect(items[0]).not.toHaveProperty('likedByMe');
      expect(items[0]).not.toHaveProperty('savedByMe');
    });

    it('a user cannot ask the feed for a tab it does not have', async () => {
      await send('get', '/feed?scope=everyone', fan, 400);
    });
  });

  describe('Likes', () => {
    it('a user who likes a piece twice counts once', async () => {
      const first = await send('post', `/content/${bLive}/like`, fan, 200);
      expect(first.data).toEqual({ likes: 1, likedByMe: true });

      const second = await send('post', `/content/${bLive}/like`, fan, 200);
      expect(second.data).toEqual({ likes: 1, likedByMe: true });

      expect(
        await prisma.contentLike.count({ where: { contentId: bLive } }),
      ).toBe(1);
      expect((await counters(bLive)).likes).toBe(1);
    });

    it('a user who taps like many times at once counts once', async () => {
      const piece = await makePiece(creatorB.sub, 'live');
      await Promise.all(
        Array.from({ length: 8 }, () =>
          send('post', `/content/${piece}/like`, otherFan, 200),
        ),
      );
      expect((await counters(piece)).likes).toBe(1);
      expect(
        await prisma.contentLike.count({ where: { contentId: piece } }),
      ).toBe(1);
    });

    it('two different users liking a piece count twice, and each sees only their own like', async () => {
      await send('post', `/content/${bLive}/like`, otherFan, 200);
      expect((await counters(bLive)).likes).toBe(2);

      const mine = await send('get', `/content/${bLive}/engagement`, fan, 200);
      expect(mine.data.likedByMe).toBe(true);

      const stranger = await send(
        'get',
        `/content/${bLive}/engagement`,
        loner,
        200,
      );
      expect(stranger.data.likedByMe).toBe(false);
      expect(stranger.data.likes).toBe(2);
    });

    it('a user can unlike, and unliking twice never goes below the real count', async () => {
      const piece = await makePiece(creatorB.sub, 'live');
      await send('post', `/content/${piece}/like`, fan, 200);
      const off = await send('delete', `/content/${piece}/like`, fan, 200);
      expect(off.data).toEqual({ likes: 0, likedByMe: false });

      const again = await send('delete', `/content/${piece}/like`, fan, 200);
      expect(again.data).toEqual({ likes: 0, likedByMe: false });
      expect((await counters(piece)).likes).toBe(0);
    });

    it('a user cannot like a piece that is not live', async () => {
      await send('post', `/content/${aPending}/like`, fan, 404);
      await send('post', `/content/${aRemoved}/like`, fan, 404);
      await send('post', `/content/${randomUUID()}/like`, fan, 404);
    });

    it('a signed-out caller cannot like', async () => {
      await send('post', `/content/${bLive}/like`, undefined, 401);
    });
  });

  describe('Views', () => {
    it('opening a piece counts one view for that person today, however often they open it', async () => {
      const piece = await makePiece(creatorB.sub, 'live');
      const first = await send('post', `/content/${piece}/view`, fan, 200);
      expect(first.data).toEqual({ views: 1, counted: true });

      const again = await send('post', `/content/${piece}/view`, fan, 200);
      expect(again.data).toEqual({ views: 1, counted: false });

      const other = await send('post', `/content/${piece}/view`, otherFan, 200);
      expect(other.data).toEqual({ views: 2, counted: true });
      expect((await counters(piece)).views).toBe(2);
    });

    it('a creator opening their own piece adds no view', async () => {
      const piece = await makePiece(creatorB.sub, 'live');
      const res = await send('post', `/content/${piece}/view`, creatorB, 200);
      expect(res.data).toEqual({ views: 0, counted: false });
      expect(
        await prisma.contentView.count({ where: { contentId: piece } }),
      ).toBe(0);
    });

    it('the same person opening a piece on another day is counted again', async () => {
      const piece = await makePiece(creatorB.sub, 'live');
      await send('post', `/content/${piece}/view`, fan, 200);
      // Yesterday's row stands in for "opened yesterday"; today's open is new.
      await prisma.contentView.updateMany({
        where: { contentId: piece },
        data: { viewedOn: new Date(Date.now() - 86_400_000) },
      });
      const res = await send('post', `/content/${piece}/view`, fan, 200);
      expect(res.data).toEqual({ views: 2, counted: true });
    });

    it('a piece that is not live cannot be viewed', async () => {
      await send('post', `/content/${aPending}/view`, fan, 404);
    });
  });

  describe('Shares', () => {
    it('a user who shares a piece twice in a day counts once, and two people count twice', async () => {
      const piece = await makePiece(creatorB.sub, 'live');
      const first = await send('post', `/content/${piece}/share`, fan, 200);
      expect(first.data).toEqual({ shares: 1, counted: true });

      const again = await send('post', `/content/${piece}/share`, fan, 200);
      expect(again.data).toEqual({ shares: 1, counted: false });

      const other = await send(
        'post',
        `/content/${piece}/share`,
        otherFan,
        200,
      );
      expect(other.data).toEqual({ shares: 2, counted: true });
    });

    it('a piece that is not live cannot be shared', async () => {
      await send('post', `/content/${aRemoved}/share`, fan, 404);
    });
  });

  describe('Per-viewer flags', () => {
    it('a user sees which feed cards they liked and saved, and the share count, and nobody else does', async () => {
      const piece = await makePiece(creatorA.sub, 'live', new Date());
      await send('post', `/content/${piece}/like`, fan, 200);
      await send('post', `/content/${piece}/save`, fan, 201);
      await send('post', `/content/${piece}/share`, otherFan, 200);

      const mine = await send(
        'get',
        '/feed?scope=following&perPage=100',
        fan,
        200,
      );
      const card = mine.list.find((i) => i.id === piece);
      expect(card).toMatchObject({
        likedByMe: true,
        savedByMe: true,
        followsCreator: true,
        shares: 1,
        likes: 1,
      });
      const untouched = mine.list.find((i) => i.id === aLive);
      expect(untouched).toMatchObject({
        likedByMe: false,
        savedByMe: false,
        shares: 0,
      });

      const theirs = await send(
        'get',
        '/feed?scope=for_you&sort=recent&perPage=100',
        otherFan,
        200,
      );
      const theirCard = theirs.list.find((i) => i.id === piece);
      expect(theirCard).toMatchObject({
        likedByMe: false,
        savedByMe: false,
        followsCreator: false,
        shares: 1,
      });
    });

    it('a user opening one piece sees its counts and their own flags', async () => {
      const res = await send('get', `/content/${aLive}/engagement`, fan, 200);
      expect(res.data).toEqual({
        likes: 0,
        views: 0,
        shares: 0,
        commentCount: 0,
        likedByMe: false,
        savedByMe: false,
        followsCreator: true,
      });
    });

    it('a creator can read engagement on their own pending piece, a stranger cannot', async () => {
      await send('get', `/content/${aPending}/engagement`, creatorA, 200);
      await send('get', `/content/${aPending}/engagement`, fan, 404);
      await send('get', `/content/${aRemoved}/engagement`, creatorA, 404);
    });

    it('GET /content/:id keeps its shape: no viewer flag is added to it', async () => {
      const res = await send('get', `/content/${aLive}`, fan, 200);
      for (const key of [
        'likedByMe',
        'savedByMe',
        'followsCreator',
        'shares',
      ]) {
        expect(res.data).not.toHaveProperty(key);
      }
    });
  });
});
