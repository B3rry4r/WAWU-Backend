// Contract tests for task POINTS-01: GET /me/points (PT5).
//
// Real HTTP against the caller's DATABASE_URL, with real RS256 tokens from
// mock-wawu-id (its port from WAWU_ID_JWKS_URL, else 4001), like every other
// contract spec. The route is mounted the way AppModule mounts it: through
// MeModule. Points are written through PointsService, the one writer. Every
// points row of the three seeded people is removed before and after (a whole
// person's ledger, the one delete the ledger allows).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
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
import { MeModule } from '../../me/me.module';
import { PointsService } from '../points.service';
import type { MyPointsView } from '../points-view.type';

const dataOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

// Seeded WAWU IDs (mock-wawu-id/server.js).
const PLAIN = '00000000-0000-4000-8000-000000000001';
const BASIC = '00000000-0000-4000-8000-000000000002';
const PRO = '00000000-0000-4000-8000-000000000003';
const SEEDED = [PLAIN, BASIC, PRO];

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

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

describe('POINTS-01: GET /me/points (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let points: PointsService;
  let mockWawuId: ChildProcess | undefined;
  let plain: string;
  let basic: string;
  let pro: string;

  const http = () => request(app.getHttpServer() as Server);
  const mine = (token: string, url = '/me/points') =>
    http().get(url).set('Authorization', `Bearer ${token}`);
  const ref = (what: string) => `p01c-${what}-${randomUUID()}`;

  async function cleanUp(): Promise<void> {
    await prisma.pointLedger.deleteMany({
      where: { wawuUserId: { in: SEEDED } },
    });
    await prisma.pointHold.deleteMany({
      where: { wawuUserId: { in: SEEDED } },
    });
    await prisma.pointLot.deleteMany({ where: { wawuUserId: { in: SEEDED } } });
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
    pro = await login('creator-pro@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
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
    points = moduleRef.get(PointsService);
    await cleanUp();
  }, 40000);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
    mockWawuId?.kill();
  });

  it('needs a signed-in caller', async () => {
    await http().get('/me/points').expect(401);
    await http()
      .get('/me/points')
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
  });

  it('someone with no points gets zero, no lots and no movements', async () => {
    const res = await mine(pro).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      statusCode: 200,
      message: 'OK',
      data: {
        balance: 0,
        nextExpiry: null,
        lots: [],
        lotCount: 0,
        movements: [],
      },
    });
  });

  describe('with points', () => {
    let soonLot: string;
    let laterLot: string;
    let basicLot: string;

    beforeAll(async () => {
      // BASIC has points of their own, which PLAIN must never see.
      basicLot = (
        await points.grant({
          wawuUserId: BASIC,
          source: 'referral',
          sourceRef: ref('basic'),
          points: 777,
          expiresAt: inDays(20),
        })
      ).lotId;
      laterLot = (
        await points.grant({
          wawuUserId: PLAIN,
          source: 'pack',
          sourceRef: ref('pack'),
          points: 1000,
          expiresAt: inDays(120),
        })
      ).lotId;
      soonLot = (
        await points.grant({
          wawuUserId: PLAIN,
          source: 'tier_bonus',
          sourceRef: ref('bonus'),
          points: 100,
          expiresAt: inDays(30),
        })
      ).lotId;
      // 24 movements more: 16 holds of 5, half spent and half given back.
      for (let i = 0; i < 16; i += 1) {
        const h = await points.hold({
          wawuUserId: PLAIN,
          purpose: 'ai_job',
          reference: ref(`job${i}`),
          points: 5,
          title: 'VoiceOver',
        });
        if (i % 2 === 0) await points.commit({ holdId: h.holdId });
        else await points.release({ holdId: h.holdId });
      }
    });

    it('shows the balance, each lot with its expiry date, and the last 20 movements, newest first', async () => {
      const view = dataOf<MyPointsView>(await mine(plain).expect(200));
      expect(view.balance).toBe(1100 - 40);
      expect(view.lotCount).toBe(2);
      expect(
        view.lots.map((l) => [l.id, l.points, l.granted, l.source, l.label]),
      ).toEqual([
        [soonLot, 60, 100, 'tier_bonus', 'Tier bonus'],
        [laterLot, 1000, 1000, 'pack', 'Bought points'],
      ]);
      const stored = await prisma.pointLot.findUniqueOrThrow({
        where: { id: soonLot },
      });
      expect(view.lots[0].expiresAt).toBe(stored.expiresAt.toISOString());
      expect(view.nextExpiry).toEqual({
        points: 60,
        expiresAt: stored.expiresAt.toISOString(),
      });

      const newest = await prisma.pointLedger.findMany({
        where: { wawuUserId: PLAIN },
        orderBy: { seq: 'desc' },
        take: 20,
      });
      expect(
        await prisma.pointLedger.count({ where: { wawuUserId: PLAIN } }),
      ).toBe(26);
      expect(view.movements).toHaveLength(20);
      expect(view.movements.map((m) => m.id)).toEqual(newest.map((r) => r.id));
      expect(view.movements[0]).toEqual({
        id: newest[0].id,
        points: 5,
        label: 'Returned from VoiceOver',
        reason: 'release',
        pending: false,
        createdAt: newest[0].at.toISOString(),
      });
      for (const m of view.movements) {
        expect(Number.isInteger(m.points)).toBe(true);
        expect(m.label).not.toMatch(/₦|\$|naira|dollar|\u2014/i);
      }
    });

    it('another person’s points are never shown', async () => {
      const theirs = await prisma.pointLedger.findMany({
        where: { wawuUserId: BASIC },
      });
      const plainView = dataOf<MyPointsView>(await mine(plain).expect(200));
      const shown = [
        ...plainView.lots.map((l) => l.id),
        ...plainView.movements.map((m) => m.id),
      ];
      expect(shown).not.toContain(basicLot);
      expect(shown.filter((id) => theirs.some((r) => r.id === id))).toEqual([]);

      // Asking for someone else by id is not a thing the route reads.
      const sneaky = dataOf<MyPointsView>(
        await mine(plain, `/me/points?wawuUserId=${BASIC}`).expect(200),
      );
      expect(sneaky.balance).toBe(plainView.balance);

      const basicView = dataOf<MyPointsView>(await mine(basic).expect(200));
      expect(basicView.balance).toBe(777);
      expect(basicView.lots.map((l) => l.id)).toEqual([basicLot]);
      expect(basicView.movements.map((m) => m.label)).toEqual([
        'Referral reward',
      ]);
    });

    it('a hold in progress shows as pending and leaves the balance at once', async () => {
      const h = await points.hold({
        wawuUserId: PLAIN,
        purpose: 'cash_out',
        reference: ref('cash'),
        points: 60,
      });
      const view = dataOf<MyPointsView>(await mine(plain).expect(200));
      expect(view.balance).toBe(1000);
      expect(view.movements[0]).toMatchObject({
        points: -60,
        reason: 'hold',
        label: 'Converting to cash',
        pending: true,
      });
      // The soonest lot is empty now, so it is no longer listed.
      expect(view.lots.map((l) => l.id)).toEqual([laterLot]);
      await points.release({ holdId: h.holdId });
      const back = dataOf<MyPointsView>(await mine(plain).expect(200));
      expect(back.balance).toBe(1060);
      expect(back.movements[1]).toMatchObject({
        label: 'Converting to cash',
        pending: false,
      });
      expect(back.movements[0]).toMatchObject({
        label: 'Conversion cancelled',
        points: 60,
      });
    });
  });
});
