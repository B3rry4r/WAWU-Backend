// Run against wawu_hub_test (set DATABASE_URL before invoking jest), the same
// convention as every other contract spec in this repo.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CommunityModule } from '../community.module';

interface Row {
  id: string;
  memberCount: number;
  slug?: string;
}
const dataOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

/**
 * FIX-99 (L5): a community room read "0 members" to its host until a fan
 * joined. Owner ruling: the host is a member. The app's room routes
 * (POST /communities/rooms, GET /communities/:id/room, /communities/links/:slug,
 * /communities/mine, /communities/suggested) count the host once; the web's
 * routes (GET /communities/:id) are protected and keep their count.
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

let nonceCount = 0;
async function registerThrowawayIdentity(
  label: string,
): Promise<{ sub: string; accessToken: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceCount += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Host Count ${label}`,
      email: `host-count-${label}-${nonce}@test.wawu.dev`,
      phone: `+2348${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`register failed for ${label}: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, accessToken: body.accessToken };
}

describe('FIX-99: the host is a member of their room (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let hostToken: string;
  let hostSub: string;
  let fanToken: string;
  let fanSub: string;
  let roomId: string;
  let slug: string;
  const server = (): App => app.getHttpServer() as App;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const runTag = Date.now().toString(36);

  const room = async (token: string): Promise<Row> =>
    dataOf<Row>(
      await request(server())
        .get(`/communities/${roomId}/room`)
        .set(auth(token))
        .expect(200),
    );
  /** The web's route: protected, so its count is the one it always had. */
  const webCount = async (token: string): Promise<number> =>
    dataOf<Row>(
      await request(server())
        .get(`/communities/${roomId}`)
        .set(auth(token))
        .expect(200),
    ).memberCount;

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
    const host = await registerThrowawayIdentity('host');
    const fan = await registerThrowawayIdentity('fan');
    hostToken = host.accessToken;
    hostSub = host.sub;
    fanToken = fan.accessToken;
    fanSub = fan.sub;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CommunityModule,
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);

    const fixture = 'Fixture for community-host-member.contract.spec.ts.';
    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: hostSub,
          accountType: 'creator',
          interests: [],
          bio: fixture,
        },
        {
          wawuUserId: fanSub,
          accountType: 'user',
          interests: [],
          bio: fixture,
        },
      ],
    });
    await prisma.creatorState.create({
      data: {
        wawuUserId: hostSub,
        kycStatus: 'pending',
        slotsUsed: 0,
        dmEnabled: false,
      },
    });
  }, 30000);

  afterAll(async () => {
    const subs = [hostSub, fanSub].filter(Boolean);
    if (subs.length > 0) {
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: subs } },
      });
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: subs } },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: subs } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: subs } },
      });
    }
    await app?.close();
    mockWawuId?.kill();
  });

  it('a room the app creates reads 1 member (its host) in the answer that made it', async () => {
    const res = await request(server())
      .post('/communities/rooms')
      .set(auth(hostToken))
      .send({
        name: `Host Count ${runTag}`,
        description: 'A room with nobody else in it yet.',
        kind: 'open',
      })
      .expect(201);
    const made = dataOf<Row>(res);
    roomId = made.id;
    slug = made.slug as string;
    expect(made.memberCount).toBe(1);
  });

  it('the room view reads 1 member to the host and to a fan who has not joined', async () => {
    expect((await room(hostToken)).memberCount).toBe(1);
    expect((await room(fanToken)).memberCount).toBe(1);
  });

  it("the room's link, the host's list and the fan's suggestions read 1", async () => {
    const byLink = dataOf<Row>(
      await request(server())
        .get(`/communities/links/${slug}`)
        .set(auth(fanToken))
        .expect(200),
    );
    expect(byLink.memberCount).toBe(1);
    const mine = dataOf<Row[]>(
      await request(server())
        .get('/communities/mine?page=1&perPage=50')
        .set(auth(hostToken))
        .expect(200),
    );
    expect(mine.find((r) => r.id === roomId)?.memberCount).toBe(1);
    const suggested = dataOf<Row[]>(
      await request(server())
        .get('/communities/suggested?page=1&perPage=100')
        .set(auth(fanToken))
        .expect(200),
    );
    expect(suggested.find((r) => r.id === roomId)?.memberCount).toBe(1);
  });

  it('GET /communities/:id, which the web calls, keeps counting the members other than the host', async () => {
    expect(await webCount(fanToken)).toBe(0);
  });

  it('a fan who joins makes it 2, and the web route 1', async () => {
    await request(server())
      .post(`/communities/${roomId}/join`)
      .set(auth(fanToken))
      .expect(200);
    expect((await room(hostToken)).memberCount).toBe(2);
    expect((await room(fanToken)).memberCount).toBe(2);
    expect(await webCount(fanToken)).toBe(1);
  });

  it('a host who also holds a joined membership row is counted once', async () => {
    await prisma.communityMembership.create({
      data: {
        communityId: roomId,
        userWawuId: hostSub,
        status: 'joined',
      },
    });
    expect((await room(hostToken)).memberCount).toBe(2);
    // The web's count is the number of joined rows, as it always was.
    expect(await webCount(fanToken)).toBe(2);
  });
});
