// Contract tests for the Notification resource (registry.json § Notification):
//   GET  /notifications             — roles: any
//   POST /notifications/mark-all-read — roles: any
//
// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// build brief). Auth is exercised for real: this spec spins up the repo's
// mock-wawu-id service (mock-wawu-id/server.js) as a real HTTP process, logs
// in as the 3 seeded WAWU IDs to get real RS256 access tokens, and lets
// WawuJwtStrategy verify them over HTTP via JWKS — no minted/injected tokens.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import { ValidationPipe, INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { NotificationModule } from '../notification.module';

const MOCK_WAWU_ID_PORT = 4001;
const MOCK_WAWU_ID_URL = `http://localhost:${MOCK_WAWU_ID_PORT}`;

// Seeded wawuUserIds — mock-wawu-id/server.js § USERS, mirrored by prisma/seed.ts.
const PLAIN_USER = { email: 'user@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000001' };
const CREATOR_BASIC = { email: 'creator-basic@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000002' };
const CREATOR_PRO = { email: 'creator-pro@test.wawu.dev', sub: '00000000-0000-4000-8000-000000000003' };

// prisma/seed.ts § NOTIFICATION_SALE_FOR_PRO / NOTIFICATION_FOLLOW_FOR_BASIC.
const SEEDED_SALE_FOR_PRO = 'a0000000-0000-4000-8000-000000000001';
const SEEDED_FOLLOW_FOR_BASIC = 'a0000000-0000-4000-8000-000000000002';

let mockWawuId: ChildProcessWithoutNullStreams | undefined;

async function waitForMockWawuId(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mock-wawu-id did not become healthy in time');
}

async function ensureMockWawuIdRunning(): Promise<void> {
  try {
    const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
    if (res.ok) return; // already running (e.g. left up by a prior run)
  } catch {
    // not running — start it below
  }
  mockWawuId = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '../../../mock-wawu-id'),
    env: { ...process.env, MOCK_WAWU_ID_PORT: String(MOCK_WAWU_ID_PORT) },
    stdio: 'pipe',
  });
  await waitForMockWawuId();
}

async function tokenFor(email: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email }),
  });
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('Notification contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plainUserToken: string;
  let creatorBasicToken: string;
  let creatorProToken: string;

  beforeAll(async () => {
    await ensureMockWawuIdRunning();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, NotificationModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    [plainUserToken, creatorBasicToken, creatorProToken] = await Promise.all([
      tokenFor(PLAIN_USER.email),
      tokenFor(CREATOR_BASIC.email),
      tokenFor(CREATOR_PRO.email),
    ]);

    // This spec asserts exact counts against the two SEEDED notifications.
    // That held only while `prisma.notification.create` existed nowhere in
    // src/ — now that NotificationService.emit() is wired into sales, tips,
    // paid DMs, follows and the cron sweeps, any suite that ran before this
    // one may legitimately have written more rows for the same seeded users.
    // Reset to the seed fixture so these assertions test the read path, not
    // whatever the rest of the suite happened to emit first.
    await prisma.notification.deleteMany({
      where: {
        userWawuId: { in: [PLAIN_USER.sub, CREATOR_BASIC.sub, CREATOR_PRO.sub] },
        id: { notIn: [SEEDED_SALE_FOR_PRO, SEEDED_FOLLOW_FOR_BASIC] },
      },
    });
  }, 30000);

  afterAll(async () => {
    await app?.close();
    mockWawuId?.kill();
  });

  describe('GET /notifications', () => {
    it('valid request → 200 with {unreadCount, items: PaginatedList<Notification>} scoped to the caller', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      const { data } = res.body;
      expect(data.unreadCount).toBe(1);
      expect(data.items).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(Array.isArray(data.items.data)).toBe(true);
      expect(data.items.data).toHaveLength(1);
      expect(data.items.data[0]).toMatchObject({ userWawuId: CREATOR_BASIC.sub, kind: 'follow', read: false });
      expect(data.items.pagination).toMatchObject({ currentPage: 1, perPage: 20, total: 1, nextPage: null });
    });

    it('scopes strictly to the caller — a user with no notifications gets an empty list, not another user’s', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.data.unreadCount).toBe(0);
      expect(res.body.data.items.data).toEqual([]);
      expect(res.body.data.items.pagination.total).toBe(0);
    });

    it('invalid payload (perPage over the conventions.md max of 100) → 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications?perPage=999')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('missing auth → 401', async () => {
      await request(app.getHttpServer()).get('/notifications').expect(401);
    });
  });

  describe('POST /notifications/mark-all-read', () => {
    it('valid request → 200 void, and flips the caller’s unread notifications to read', async () => {
      const before = await prisma.notification.findMany({ where: { userWawuId: CREATOR_PRO.sub } });
      expect(before.some((n) => !n.read)).toBe(true);

      const res = await request(app.getHttpServer())
        .post('/notifications/mark-all-read')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK', data: null });

      const after = await prisma.notification.findMany({ where: { userWawuId: CREATOR_PRO.sub } });
      expect(after.every((n) => n.read)).toBe(true);

      // restore fixture state for repeatability across local runs
      await prisma.notification.updateMany({ where: { userWawuId: CREATOR_PRO.sub }, data: { read: false } });
    });

    it('invalid payload (stray field, forbidNonWhitelisted) → 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/notifications/mark-all-read')
        .set('Authorization', `Bearer ${creatorBasicToken}`)
        .send({ notAContractField: true })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it('missing auth → 401', async () => {
      await request(app.getHttpServer()).post('/notifications/mark-all-read').expect(401);
    });
  });
});
