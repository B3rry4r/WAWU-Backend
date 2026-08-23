// Contract tests for every place NotificationService.emit() is CALLED.
//
// The emitter's own behaviour is covered by notification-emitter.contract.spec.ts.
// This spec proves the wiring: that a real settled sale/tip/paid-DM/refund/
// renewal actually writes the right notification to the right person, that an
// event which did NOT complete writes nothing, and that a NotificationSettings
// flag suppresses what it claims to.
//
// Runs against the caller's own DATABASE_URL (per the build brief) and drives
// real HTTP with real RS256 tokens from mock-wawu-id, exactly like the other
// contract specs in this repo.

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
import { NotificationModule } from '../notification.module';
import { NotificationService } from '../notification.service';
import { PurchaseModule } from '../../purchase/purchase.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { DirectMessageModule } from '../../direct-message/direct-message.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';
import { CommunityMessageModule } from '../../community-message/community-message.module';
import { CreatorSubscriptionModule } from '../../creator-subscription/creator-subscription.module';
import { DmRefundService } from '../../direct-message/dm-refund.service';
import { SchedulerService } from '../../scheduler/scheduler.service';
import { MOCK_FAILURE_TRANSACTION_ID } from '../../purchase/mock-flutterwave.adapter';
import { MOCK_CARD_TOKEN } from '../../creator-subscription/mock-flutterwave.adapter';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts.
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // basic tier -> 0.15 commission
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // pro tier -> 0.10 commission, dmPrice 300
const SEEDED_USERS = [USER_PLAIN, USER_CREATOR_BASIC, USER_CREATOR_PRO];

// prisma/seed.ts fixtures this spec must leave exactly as it found them.
const SEEDED_NOTIFICATIONS = [
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
];
const CONTENT_PDF_TEMPLATE = '10000000-0000-4000-8000-000000000003'; // paid, ₦1500, creator = PRO
const COMMUNITY_FOUNDERS = '20000000-0000-4000-8000-000000000001'; // open, host = PRO, PLAIN is a member
const SEEDED_DM = '90000000-0000-4000-8000-000000000001';

// Synthetic rows this spec creates and removes.
const SYNTHETIC_DM_EXPIRED = 'e2000000-0000-4000-8000-000000000001';
const SYNTHETIC_DM_DUE_SOON = 'e2000000-0000-4000-8000-000000000002';
const SYNTHETIC_FAN = 'e2000000-0000-4000-8000-0000000000f1';
const SYNTHETIC_TRIAL_USER = 'e2000000-0000-4000-8000-0000000000f2';
const SYNTHETIC_LAPSED_CREATOR = 'e2000000-0000-4000-8000-0000000000f3';
/**
 * The sweep fixtures own their creator rather than borrowing the seeded one.
 *
 * They used to hang off USER_CREATOR_PRO, who also owns a SEEDED DirectMessage
 * whose `deadlineAt` is relative to seed time. That put the "ignores a DM
 * outside the hourly band" assertion on a timer: the seeded DM drifts through
 * remindDmDeadlines' 3-4h window a few hours after every re-seed, and while it
 * sits inside, the sweep correctly emits for it — and the test read that
 * emission as its own synthetic DM leaking. Green or red depending on the
 * clock, with the production code correct either way.
 */
const SYNTHETIC_DM_CREATOR = 'e2000000-0000-4000-8000-0000000000f4';
const SYNTHETIC_USERS = [
  SYNTHETIC_FAN,
  SYNTHETIC_TRIAL_USER,
  SYNTHETIC_LAPSED_CREATOR,
  SYNTHETIC_DM_CREATOR,
];

const HOUR = 60 * 60 * 1000;

/** Nest answers a POST with 201 unless the handler says otherwise; both are success here. */
const expectOk = (res: { status: number }) => {
  expect([200, 201]).toContain(res.status);
};

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

describe('Notification wiring (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let scheduler: SchedulerService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainToken: string;
  let creatorBasicToken: string;

  /** Everything except the two seeded fixture rows. */
  const clearEmitted = () =>
    prisma.notification.deleteMany({
      where: {
        userWawuId: { in: [...SEEDED_USERS, ...SYNTHETIC_USERS] },
        id: { notIn: SEEDED_NOTIFICATIONS },
      },
    });

  const emittedFor = (userWawuId: string, kind?: string) =>
    prisma.notification.findMany({
      where: { userWawuId, id: { notIn: SEEDED_NOTIFICATIONS }, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
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
    creatorBasicToken = await login('creator-basic@test.wawu.dev');

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
        CommunityMessageModule,
        CreatorSubscriptionModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationService);
    // Constructed directly rather than via SchedulerModule so no @Cron is
    // ever registered by a test run — the sweeps are invoked explicitly.
    scheduler = new SchedulerService(
      prisma,
      notifications,
      moduleRef.get(DmRefundService),
    );

    await clearEmitted();
  }, 40000);

  afterAll(async () => {
    // Leave the seeded world exactly as it was found.
    await clearEmitted();
    await prisma.directMessage.deleteMany({
      where: { id: { in: [SYNTHETIC_DM_EXPIRED, SYNTHETIC_DM_DUE_SOON] } },
    });
    await prisma.directMessage.deleteMany({ where: { senderWawuId: USER_PLAIN, creatorWawuId: USER_CREATOR_PRO, id: { not: SEEDED_DM } } });
    await prisma.directMessage.updateMany({ where: { id: SEEDED_DM }, data: { status: 'awaiting_response' } });
    await prisma.purchase.deleteMany({ where: { buyerWawuId: USER_PLAIN, contentId: CONTENT_PDF_TEMPLATE } });
    await prisma.followRelationship.deleteMany({
      where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_BASIC },
    });
    await prisma.creditsState.deleteMany({ where: { userWawuId: SYNTHETIC_TRIAL_USER } });
    await prisma.creatorSubscription.deleteMany({ where: { creatorWawuId: SYNTHETIC_LAPSED_CREATOR } });
    await prisma.notificationSettings.deleteMany({ where: { userWawuId: { in: SYNTHETIC_USERS } } });
    await app?.close();
    await moduleRef?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  }, 30000);

  beforeEach(clearEmitted);

  // -------------------------------------------------------------------------
  describe('a settled tip notifies the creator', () => {
    it('POST /tips + /tips/verify writes tip_received to the CREATOR with the post-commission amount', async () => {
      const init = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 1000 });
      const { txRef } = init.body.data.flutterwaveConfig;

      await request(app.getHttpServer())
        .post('/tips/verify')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ tx_ref: txRef, transaction_id: 'mock-flw-tx-1' })
        .expect(expectOk);

      const [row] = await emittedFor(USER_CREATOR_BASIC, 'tip_received');
      expect(row).toBeDefined();
      // Basic tier -> 0.15 commission, snapshotted on the Purchase row.
      expect(row.amount).toBe(850);
      expect(row.body).toContain('₦850');
      // The tipper is not notified about their own action.
      expect(await emittedFor(USER_PLAIN, 'tip_received')).toHaveLength(0);
    });

    it('is written once, not twice, when the same tip is verified again (webhook + browser race)', async () => {
      const init = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 400 });
      const { txRef } = init.body.data.flutterwaveConfig;

      const body = { tx_ref: txRef, transaction_id: 'mock-flw-tx-2' };
      await request(app.getHttpServer()).post('/tips/verify').set('Authorization', `Bearer ${plainToken}`).send(body);
      await request(app.getHttpServer()).post('/tips/verify').set('Authorization', `Bearer ${plainToken}`).send(body);

      expect(await emittedFor(USER_CREATOR_BASIC, 'tip_received')).toHaveLength(1);
    });

    it('writes NOTHING when Flutterwave reports the charge failed', async () => {
      const init = await request(app.getHttpServer())
        .post('/tips')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ creatorWawuId: USER_CREATOR_BASIC, amount: 700 });
      const { txRef } = init.body.data.flutterwaveConfig;

      await request(app.getHttpServer())
        .post('/tips/verify')
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ tx_ref: txRef, transaction_id: MOCK_FAILURE_TRANSACTION_ID })
        .expect(400);

      expect(await emittedFor(USER_CREATOR_BASIC)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('a settled content unlock notifies the creator', () => {
    it('POST /content/:id/unlock + verify writes `sale` to the creator with the title and the net amount', async () => {
      await prisma.purchase.deleteMany({ where: { buyerWawuId: USER_PLAIN, contentId: CONTENT_PDF_TEMPLATE } });

      const init = await request(app.getHttpServer())
        .post(`/content/${CONTENT_PDF_TEMPLATE}/unlock`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({});
      const { txRef } = init.body.data.flutterwaveConfig;

      await request(app.getHttpServer())
        .post(`/content/${CONTENT_PDF_TEMPLATE}/unlock/verify`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ tx_ref: txRef, transaction_id: 'mock-flw-tx-3' })
        .expect(expectOk);

      const [row] = await emittedFor(USER_CREATOR_PRO, 'sale');
      expect(row).toBeDefined();
      // Pro tier -> 0.10 commission on a ₦1500 unlock.
      expect(row.amount).toBe(1350);
      expect(row.body).toContain('Invoice Template Pack');
      expect(row.body).toContain('₦1,350');
      expect(await emittedFor(USER_PLAIN, 'sale')).toHaveLength(0);
    });

    it('writes NOTHING when the unlock payment fails verification', async () => {
      await prisma.purchase.deleteMany({ where: { buyerWawuId: USER_PLAIN, contentId: CONTENT_PDF_TEMPLATE } });

      const init = await request(app.getHttpServer())
        .post(`/content/${CONTENT_PDF_TEMPLATE}/unlock`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({});
      const { txRef } = init.body.data.flutterwaveConfig;

      await request(app.getHttpServer())
        .post(`/content/${CONTENT_PDF_TEMPLATE}/unlock/verify`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ tx_ref: txRef, transaction_id: MOCK_FAILURE_TRANSACTION_ID })
        .expect(400);

      expect(await emittedFor(USER_CREATOR_PRO, 'sale')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('a paid DM notifies the creator once it is paid for', () => {
    it('send + verify writes dm_received to the creator with the snapshotted dmPrice', async () => {
      const init = await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ text: 'Do you take commissions?' });
      const { threadId, flutterwaveConfig } = init.body.data;

      await request(app.getHttpServer())
        .post(`/dm/${threadId}/send/verify`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ tx_ref: flutterwaveConfig.txRef, transaction_id: 'mock-flw-tx-4' })
        .expect(expectOk);

      const [row] = await emittedFor(USER_CREATOR_PRO, 'dm_received');
      expect(row).toBeDefined();
      expect(row.amount).toBe(300);
      expect(row.actionLabel).toBe('Reply now');
      expect(await emittedFor(USER_PLAIN, 'dm_received')).toHaveLength(0);
    });

    it('writes NOTHING when the DM charge fails — an unpaid DM is not a received DM', async () => {
      const init = await request(app.getHttpServer())
        .post(`/dm/${USER_CREATOR_PRO}/send`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ text: 'This one never gets paid for.' });
      const { threadId, flutterwaveConfig } = init.body.data;

      await request(app.getHttpServer())
        .post(`/dm/${threadId}/send/verify`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send({ tx_ref: flutterwaveConfig.txRef, transaction_id: MOCK_FAILURE_TRANSACTION_ID })
        .expect(400);

      expect(await emittedFor(USER_CREATOR_PRO, 'dm_received')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('a new follow notifies the creator exactly once', () => {
    it('writes new_follower on the first follow and nothing on an idempotent repeat', async () => {
      await prisma.followRelationship.deleteMany({
        where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_BASIC },
      });

      await request(app.getHttpServer())
        .post(`/creators/${USER_CREATOR_BASIC}/follow`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send();
      expect(await emittedFor(USER_CREATOR_BASIC, 'new_follower')).toHaveLength(1);

      await request(app.getHttpServer())
        .post(`/creators/${USER_CREATOR_BASIC}/follow`)
        .set('Authorization', `Bearer ${plainToken}`)
        .send();
      expect(await emittedFor(USER_CREATOR_BASIC, 'new_follower')).toHaveLength(1);
    });

    it('is suppressed when the creator has turned newFollowers off', async () => {
      const before = await prisma.notificationSettings.findUnique({ where: { userWawuId: USER_CREATOR_BASIC } });
      await prisma.followRelationship.deleteMany({
        where: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_BASIC },
      });
      await prisma.notificationSettings.upsert({
        where: { userWawuId: USER_CREATOR_BASIC },
        update: { newFollowers: false },
        create: { userWawuId: USER_CREATOR_BASIC, newFollowers: false },
      });

      try {
        await request(app.getHttpServer())
          .post(`/creators/${USER_CREATOR_BASIC}/follow`)
          .set('Authorization', `Bearer ${plainToken}`)
          .send();

        expect(await emittedFor(USER_CREATOR_BASIC, 'new_follower')).toHaveLength(0);
      } finally {
        await prisma.notificationSettings.update({
          where: { userWawuId: USER_CREATOR_BASIC },
          data: { newFollowers: before?.newFollowers ?? true },
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('running the credits balance down warns the spender', () => {
    it('warns on the send that crosses the low-credits threshold, and not on the one before it', async () => {
      const before = await prisma.creditsState.findUnique({ where: { userWawuId: USER_PLAIN } });

      try {
        // 7 credits -> the first send lands on 6 (above the threshold, quiet),
        // the second lands on 5 (crossing, warned).
        await prisma.creditsState.update({ where: { userWawuId: USER_PLAIN }, data: { creditBalance: 7 } });

        await request(app.getHttpServer())
          .post(`/communities/${COMMUNITY_FOUNDERS}/messages`)
          .set('Authorization', `Bearer ${plainToken}`)
          .send({ text: 'Still plenty of credits here.' });
        expect(await emittedFor(USER_PLAIN, 'credits_low')).toHaveLength(0);

        await request(app.getHttpServer())
          .post(`/communities/${COMMUNITY_FOUNDERS}/messages`)
          .set('Authorization', `Bearer ${plainToken}`)
          .send({ text: 'And now I am running low.' });

        const [row] = await emittedFor(USER_PLAIN, 'credits_low');
        expect(row).toBeDefined();
        expect(row.creditsCount).toBe(5);
        // WAWU Credits render as a COUNT, never a naira value.
        expect(row.amount).toBeNull();
        expect(row.body).toContain('5 credits');
        expect(row.body).not.toContain('₦');
      } finally {
        await prisma.creditsState.update({
          where: { userWawuId: USER_PLAIN },
          data: { creditBalance: before?.creditBalance ?? 48 },
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('a successful subscription renewal notifies the creator', () => {
    it('POST /creator-subscription/retry-payment writes subscription_renewal on success', async () => {
      const before = await prisma.creatorSubscription.findUnique({ where: { creatorWawuId: USER_CREATOR_BASIC } });
      if (!before) throw new Error('seed is missing the Basic creator subscription');

      await prisma.creatorSubscription.update({
        where: { creatorWawuId: USER_CREATOR_BASIC },
        data: {
          status: 'past_due',
          currentPeriodEnd: new Date(Date.now() - HOUR),
          renewalAttempts: 1,
          flutterwaveCustomerRef: MOCK_CARD_TOKEN,
        },
      });

      try {
        await request(app.getHttpServer())
          .post('/creator-subscription/retry-payment')
          .set('Authorization', `Bearer ${creatorBasicToken}`)
          .send()
          .expect(201);

        const [row] = await emittedFor(USER_CREATOR_BASIC, 'subscription_renewal');
        expect(row).toBeDefined();
        expect(row.tone).toBe('success');
        expect(row.amount).toBeGreaterThan(0);
        expect(row.body).toContain('₦');
        expect(row.body).toContain('Basic');
      } finally {
        await prisma.creatorSubscription.update({
          where: { creatorWawuId: USER_CREATOR_BASIC },
          data: {
            status: before.status,
            currentPeriodEnd: before.currentPeriodEnd,
            renewalAttempts: before.renewalAttempts,
            flutterwaveCustomerRef: before.flutterwaveCustomerRef,
          },
        });
        await prisma.creatorState.updateMany({
          where: { wawuUserId: USER_CREATOR_BASIC },
          data: { subscriptionPaid: true, tier: 'basic' },
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the scheduled sweeps', () => {
    /**
     * `flutterwaveTxId` matters here. The sweep no longer announces a refund
     * by itself — it records the debt, and the executor announces it once
     * Flutterwave has actually paid. Without a transaction id there is no
     * refund to send, the row escalates to the finance queue, and the payer
     * is correctly NOT told their money is back.
     */
    const makeDm = (
      id: string,
      deadlineAt: Date,
      senderWawuId: string,
      flutterwaveTxId: string | null = `sweep-tx-${id}`,
    ) =>
      prisma.directMessage.create({
        data: {
          id,
          creatorWawuId: SYNTHETIC_DM_CREATOR,
          senderWawuId,
          text: 'Synthetic DM for the sweep tests.',
          amount: 300,
          status: 'awaiting_response',
          sentAt: new Date(deadlineAt.getTime() - 24 * HOUR),
          deadlineAt,
          flutterwaveTxRef: `sweep-${id}`,
          flutterwaveTxId,
        },
      });

    it('refundExpiredDms refunds the FAN who paid and tells them once it settles', async () => {
      await prisma.directMessage.deleteMany({ where: { id: SYNTHETIC_DM_EXPIRED } });
      await makeDm(SYNTHETIC_DM_EXPIRED, new Date(Date.now() - HOUR), USER_PLAIN);

      await scheduler.refundExpiredDms();

      const [row] = await emittedFor(USER_PLAIN, 'dm_refunded');
      expect(row).toBeDefined();
      expect(row.amount).toBe(300);
      expect(row.body).toContain('₦300');
      // The refund is the fan's news; the creator is not told they were paid.
      expect(await emittedFor(USER_CREATOR_PRO, 'dm_refunded')).toHaveLength(0);

      const dm = await prisma.directMessage.findUnique({ where: { id: SYNTHETIC_DM_EXPIRED } });
      expect(dm?.status).toBe('refunded');
      // And the money actually moved, which is the whole point: the message
      // above is only allowed to exist because this is `settled`.
      expect(dm?.refundStatus).toBe('settled');
      expect(dm?.refundedAt).not.toBeNull();
    });

    it('refundExpiredDms does NOT tell the fan when the refund could not be sent', async () => {
      // The failure this feature was built to remove. A DM with no captured
      // transaction id cannot be refunded by API; the debt is real and goes
      // to the finance queue, and the payer must not be told otherwise.
      await prisma.directMessage.deleteMany({ where: { id: SYNTHETIC_DM_EXPIRED } });
      await makeDm(SYNTHETIC_DM_EXPIRED, new Date(Date.now() - HOUR), USER_PLAIN, null);

      await scheduler.refundExpiredDms();

      expect(await emittedFor(USER_PLAIN, 'dm_refunded')).toHaveLength(0);
      const dm = await prisma.directMessage.findUnique({ where: { id: SYNTHETIC_DM_EXPIRED } });
      expect(dm?.status).toBe('refunded');
      expect(dm?.refundStatus).toBe('failed');
      expect(dm?.refundError).toContain('cannot be refunded automatically');
    });

    it('refundExpiredDms is suppressed for a fan who turned `refunds` off', async () => {
      await prisma.directMessage.deleteMany({ where: { id: SYNTHETIC_DM_EXPIRED } });
      await makeDm(SYNTHETIC_DM_EXPIRED, new Date(Date.now() - HOUR), SYNTHETIC_FAN);
      await prisma.notificationSettings.upsert({
        where: { userWawuId: SYNTHETIC_FAN },
        update: { refunds: false },
        create: { userWawuId: SYNTHETIC_FAN, refunds: false },
      });

      await scheduler.refundExpiredDms();

      expect(await emittedFor(SYNTHETIC_FAN, 'dm_refunded')).toHaveLength(0);
      // The refund itself still happened — only the notification was muted.
      const dm = await prisma.directMessage.findUnique({ where: { id: SYNTHETIC_DM_EXPIRED } });
      expect(dm?.status).toBe('refunded');
    });

    it('remindDmDeadlines warns the creator about a window closing in ~3 hours', async () => {
      await prisma.directMessage.deleteMany({ where: { id: SYNTHETIC_DM_DUE_SOON } });
      await makeDm(SYNTHETIC_DM_DUE_SOON, new Date(Date.now() + 3.5 * HOUR), USER_PLAIN);

      await scheduler.remindDmDeadlines();

      const [row] = await emittedFor(SYNTHETIC_DM_CREATOR, 'dm_deadline');
      expect(row).toBeDefined();
      expect(row.tone).toBe('danger');
      expect(row.actionLabel).toBe('Reply now');
      expect(row.amount).toBeNull();
    });

    it('remindDmDeadlines ignores a DM whose deadline is outside the hourly band', async () => {
      await prisma.directMessage.deleteMany({ where: { id: SYNTHETIC_DM_DUE_SOON } });
      await makeDm(SYNTHETIC_DM_DUE_SOON, new Date(Date.now() + 12 * HOUR), USER_PLAIN);

      await scheduler.remindDmDeadlines();

      expect(await emittedFor(SYNTHETIC_DM_CREATOR, 'dm_deadline')).toHaveLength(0);
    });

    it('warnCreditsTrialEnding warns a trial ending tomorrow, as a COUNT', async () => {
      await prisma.creditsState.upsert({
        where: { userWawuId: SYNTHETIC_TRIAL_USER },
        update: { creditBalance: 12, trialEndsAt: new Date(Date.now() + 30 * HOUR) },
        create: { userWawuId: SYNTHETIC_TRIAL_USER, creditBalance: 12, trialEndsAt: new Date(Date.now() + 30 * HOUR) },
      });

      await scheduler.warnCreditsTrialEnding();

      const [row] = await emittedFor(SYNTHETIC_TRIAL_USER, 'trial_ending');
      expect(row).toBeDefined();
      expect(row.creditsCount).toBe(12);
      expect(row.amount).toBeNull();
      expect(row.body).toContain('12 credits');
      // The seeded users' trials end in 7 days — well outside the band.
      expect(await emittedFor(USER_PLAIN, 'trial_ending')).toHaveLength(0);
    });

    it('expireLapsedSubscriptions tells the creator their subscription did not renew', async () => {
      await prisma.creatorSubscription.deleteMany({ where: { creatorWawuId: SYNTHETIC_LAPSED_CREATOR } });
      await prisma.creatorSubscription.create({
        data: {
          creatorWawuId: SYNTHETIC_LAPSED_CREATOR,
          tier: 'basic',
          status: 'active',
          currentPeriodEnd: new Date(Date.now() - HOUR),
        },
      });

      await scheduler.expireLapsedSubscriptions();

      const [row] = await emittedFor(SYNTHETIC_LAPSED_CREATOR, 'subscription_renewal');
      expect(row).toBeDefined();
      expect(row.tone).toBe('warning');
      expect(row.actionLabel).toBe('Retry payment');
      expect(row.body).toContain('Basic');

      // The seeded creators' subscriptions run to 2027 and must be untouched.
      const seeded = await prisma.creatorSubscription.findUnique({ where: { creatorWawuId: USER_CREATOR_PRO } });
      expect(seeded?.status).toBe('active');
    });
  });
});
