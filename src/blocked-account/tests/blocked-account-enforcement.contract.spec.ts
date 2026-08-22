// Contract tests for blocking — the write path that did not exist, and the
// enforcement that made the table matter.
//
// Before this change: `blockedAccount.create` was called nowhere in the repo,
// so a block could not be made; and nothing read the table, so a row inserted
// by hand changed nothing. The privacy screen in the web app offered a feature
// the backend could neither record nor honour.
//
// These tests cover both halves: POST/GET/DELETE on
// /settings/privacy/blocked, and what a live block actually PREVENTS.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
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
import { BlockedAccountModule } from '../blocked-account.module';
import { NotificationModule } from '../../notification/notification.module';
import { PurchaseModule } from '../../purchase/purchase.module';
import { DirectMessageModule } from '../../direct-message/direct-message.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';
import { CommentModule } from '../../comment/comment.module';

const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // dmPrice 300, dmEnabled
const NONEXISTENT_WAWU_ID = 'ffffffff-0000-4000-8000-000000000099';

// Every gated interaction in this spec is aimed at the SAME counterparty (the
// Pro creator), so one block covers all four. The makeup video is deliberately
// not used — it belongs to the Basic creator.
const CONTENT_BY_PRO = '10000000-0000-4000-8000-000000000001'; // 'SEEDED: CAC in 7 days', creator = PRO
const SEEDED_NOTIFICATIONS = [
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
];

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
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Blocking (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainToken: string;
  let creatorProToken: string;
  let seededCommentCount = 0;

  const clearBlocks = () =>
    prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: [USER_PLAIN, USER_CREATOR_BASIC, USER_CREATOR_PRO] } },
    });

  /** Everything a blocked party might try, as the plain user against the Pro creator. */
  const attempts = () => ({
    dm: () =>
      request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ text: 'Hello?' }),
    tip: () =>
      request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ creatorWawuId: USER_CREATOR_PRO, amount: 500 }),
    follow: () =>
      request(app.getHttpServer())
        .post(`/creators/${USER_CREATOR_PRO}/follow`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send(),
    comment: () =>
      request(app.getHttpServer())
        .post(`/content/${CONTENT_BY_PRO}/comments`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ text: 'Nice tutorial.' }),
  });

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    plainToken = await login('user@test.wawu.dev');
    creatorProToken = await login('creator-pro@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        BlockedAccountModule,
        PurchaseModule,
        DirectMessageModule,
        FollowRelationshipModule,
        CommentModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    seededCommentCount =
      (await prisma.contentPiece.findUnique({ where: { id: CONTENT_BY_PRO }, select: { commentCount: true } }))
        ?.commentCount ?? 0;
    await clearBlocks();
  }, 40000);

  afterAll(async () => {
    // Blocks are enforced now, so a leftover row would 403 other suites.
    await clearBlocks();
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
    });
    await prisma.comment.deleteMany({
      where: { contentId: CONTENT_BY_PRO, authorWawuId: USER_PLAIN, text: 'Nice tutorial.' },
    });
    // Comment creation increments the denormalised counter; put it back.
    await prisma.contentPiece.update({
      where: { id: CONTENT_BY_PRO },
      data: { commentCount: seededCommentCount },
    });
    await prisma.notification.deleteMany({
      where: {
        userWawuId: { in: [USER_PLAIN, USER_CREATOR_BASIC, USER_CREATOR_PRO] },
        id: { notIn: SEEDED_NOTIFICATIONS },
      },
    });
    await app?.close();
    await moduleRef?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  }, 30000);

  beforeEach(clearBlocks);

  // -------------------------------------------------------------------------
  describe('POST /settings/privacy/blocked', () => {
    it('creates the block and returns the BlockedAccount row the DELETE needs', async () => {
      const res = await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data).toMatchObject({
        userWawuId: USER_PLAIN,
        blockedWawuId: USER_CREATOR_PRO,
        id: expect.any(String),
      });

      const stored = await prisma.blockedAccount.findUnique({ where: { id: res.body.data.id } });
      expect(stored).not.toBeNull();
    });

    it('is idempotent — blocking twice returns the same row, not a 409 or a duplicate', async () => {
      const first = await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });
      const second = await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(
        await prisma.blockedAccount.count({ where: { userWawuId: USER_PLAIN, blockedWawuId: USER_CREATOR_PRO } }),
      ).toBe(1);
    });

    it('the new block shows up in the existing GET list, unchanged in shape', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      const res = await request(app.getHttpServer())
        .get('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.data.some((b: { blockedWawuId: string }) => b.blockedWawuId === USER_CREATOR_PRO)).toBe(true);
      expect(res.body.pagination).toEqual(expect.objectContaining({ currentPage: 1, perPage: 20 }));
    });

    it('400s on blocking yourself', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_PLAIN })
        .expect(400);
    });

    it('404s for an account that does not exist', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: NONEXISTENT_WAWU_ID })
        .expect(404);
    });

    it('400s on a malformed body and 401s with no auth', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: 'not-a-uuid' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .send({ blockedWawuId: USER_CREATOR_PRO })
        .expect(401);
    });

    it('severs any follow edge in BOTH directions', async () => {
      await prisma.followRelationship.createMany({
        data: [{ followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO }],
        skipDuplicates: true,
      });

      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      expect(
        await prisma.followRelationship.count({
          where: {
            OR: [
              { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_PRO },
              { followerWawuId: USER_CREATOR_PRO, followingWawuId: USER_PLAIN },
            ],
          },
        }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('what a block actually PREVENTS', () => {
    it('the blocker cannot pay, message, follow or comment at the account they blocked', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      const a = attempts();
      await a.dm().expect(403);
      await a.tip().expect(403);
      await a.follow().expect(403);
      await a.comment().expect(403);
    });

    it('the BLOCKED party is stopped too — enforcement is symmetric', async () => {
      // The creator blocks the fan; every attempt is made by the fan.
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ blockedWawuId: USER_PLAIN });

      const a = attempts();
      await a.dm().expect(403);
      await a.tip().expect(403);
      await a.follow().expect(403);
      await a.comment().expect(403);
    });

    it('a blocked paid DM is refused BEFORE any charge is initialised — no money is taken', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ blockedWawuId: USER_PLAIN });

      const before = await prisma.pendingCharge.count({ where: { wawuUserId: USER_PLAIN, kind: 'dm' } });
      await attempts().dm().expect(403);
      const after = await prisma.pendingCharge.count({ where: { wawuUserId: USER_PLAIN, kind: 'dm' } });

      expect(after).toBe(before);
    });

    it('a blocked tip never creates a pending Purchase row', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      const before = await prisma.purchase.count({
        where: { buyerWawuId: USER_PLAIN, creatorWawuId: USER_CREATOR_PRO, type: 'tip' },
      });
      await attempts().tip().expect(403);
      const after = await prisma.purchase.count({
        where: { buyerWawuId: USER_PLAIN, creatorWawuId: USER_CREATOR_PRO, type: 'tip' },
      });

      expect(after).toBe(before);
    });

    it('reading is still allowed — a block gates interaction, not visibility', async () => {
      await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      await request(app.getHttpServer())
        .get(`/content/${CONTENT_BY_PRO}/comments`)
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('DELETE /settings/privacy/blocked/:id restores what the block prevented', () => {
    it('unblocking lets the paid DM, the tip, the follow and the comment through again', async () => {
      const created = await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ blockedWawuId: USER_CREATOR_PRO });

      await attempts().dm().expect(403);

      await request(app.getHttpServer())
        .delete(`/settings/privacy/blocked/${created.body.data.id}`)
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(200);

      const a = attempts();
      expect([200, 201]).toContain((await a.dm()).status);
      expect([200, 201]).toContain((await a.tip()).status);
      expect([200, 201]).toContain((await a.follow()).status);
      expect([200, 201]).toContain((await a.comment()).status);
    });

    it('a caller cannot unblock another user’s block row', async () => {
      const created = await request(app.getHttpServer())
        .post('/settings/privacy/blocked')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ blockedWawuId: USER_PLAIN });

      await request(app.getHttpServer())
        .delete(`/settings/privacy/blocked/${created.body.data.id}`)
        .set('Authorization', `Bearer ${plainToken}`)
        .expect(404);

      expect(await prisma.blockedAccount.findUnique({ where: { id: created.body.data.id } })).not.toBeNull();
    });
  });
});
