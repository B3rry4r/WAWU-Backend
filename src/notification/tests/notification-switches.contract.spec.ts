// SETTINGS-07: the notification switches Settings draws are saved, read back,
// and honoured by the sender of each kind.
//
// Real HTTP with real RS256 tokens from mock-wawu-id (like the wiring spec):
// the settings routes, then the real tip, unlock and follow routes that write
// the notifications. The review kinds are sent from the admin moderation
// screen, so they go through NotificationService.emit(), the one place every
// sender's notification is decided.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

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
import { NotificationModule } from '../notification.module';
import { NotificationService } from '../notification.service';
import { NotificationSettingsModule } from '../../notification-settings/notification-settings.module';
import { PurchaseModule } from '../../purchase/purchase.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { FollowRelationshipModule } from '../../follow-relationship/follow-relationship.module';

const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';
const USER_NO_ROW = 'e3000000-0000-4000-8000-0000000000a1';
const USERS = [USER_PLAIN, USER_CREATOR_BASIC, USER_CREATOR_PRO, USER_NO_ROW];
const CONTENT_PDF_TEMPLATE = '10000000-0000-4000-8000-000000000003'; // paid, creator = PRO
const SEEDED_NOTIFICATIONS = [
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
];

/** The `data` of the wrapped response, typed so a missing key is a failed assertion, not an `any`. */
const dataOf = (res: { body: unknown }): Record<string, unknown> =>
  (res.body as { data: Record<string, unknown> }).data;
const txRefOf = (res: { body: unknown }): string =>
  (dataOf(res).flutterwaveConfig as { txRef: string }).txRef;

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

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
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Notification switches (contract, SETTINGS-07)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let mockWawuId: ChildProcess | undefined;
  let plainToken: string;
  let basicToken: string;
  let proToken: string;
  const saved = new Map<string, unknown>();
  /** Purchases USER_PLAIN already had, so afterAll removes only what this spec made. */
  let purchasesBefore: string[] = [];
  /** Notifications that existed before this spec ran (seeded or left by another spec): never read, never deleted. */
  let keep: string[] = [...SEEDED_NOTIFICATIONS];
  /** Whether the seeded follow edge (plain user to basic creator) existed, so afterAll restores it. */
  let followedBefore = false;

  const emittedFor = (userWawuId: string, kind?: string) =>
    prisma.notification.findMany({
      where: {
        userWawuId,
        id: { notIn: keep },
        ...(kind ? { kind } : {}),
      },
    });

  const clearEmitted = () =>
    prisma.notification.deleteMany({
      where: {
        userWawuId: { in: USERS },
        id: { notIn: keep },
      },
    });

  const server = () => app.getHttpServer() as Server;
  const patch = (token: string, body: object) =>
    request(server())
      .patch('/settings/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const read = (token: string) =>
    request(server())
      .get('/settings/notifications')
      .set('Authorization', `Bearer ${token}`);

  /** A tip from USER_PLAIN to the basic creator, settled through the real routes. */
  const tip = async (amount: number, txId: string) => {
    const init = await request(server())
      .post('/tips')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ creatorWawuId: USER_CREATOR_BASIC, amount });
    await request(server())
      .post('/tips/verify')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({
        tx_ref: txRefOf(init),
        transaction_id: txId,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
  };

  /** An unlock of the PRO creator's paid content by USER_PLAIN. */
  const unlock = async (txId: string) => {
    await prisma.purchase.deleteMany({
      where: { buyerWawuId: USER_PLAIN, contentId: CONTENT_PDF_TEMPLATE },
    });
    const init = await request(server())
      .post(`/content/${CONTENT_PDF_TEMPLATE}/unlock`)
      .set('Authorization', `Bearer ${plainToken}`)
      .send({});
    await request(server())
      .post(`/content/${CONTENT_PDF_TEMPLATE}/unlock/verify`)
      .set('Authorization', `Bearer ${plainToken}`)
      .send({
        tx_ref: txRefOf(init),
        transaction_id: txId,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
  };

  const follow = async () => {
    await prisma.followRelationship.deleteMany({
      where: {
        followerWawuId: USER_PLAIN,
        followingWawuId: USER_CREATOR_BASIC,
      },
    });
    await request(server())
      .post(`/creators/${USER_CREATOR_BASIC}/follow`)
      .set('Authorization', `Bearer ${plainToken}`)
      .send();
  };

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
    plainToken = await login('user@test.wawu.dev');
    basicToken = await login('creator-basic@test.wawu.dev');
    proToken = await login('creator-pro@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        NotificationSettingsModule,
        PurchaseModule,
        ContentPieceModule,
        FollowRelationshipModule,
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
    notifications = moduleRef.get(NotificationService);

    for (const id of [USER_CREATOR_BASIC, USER_CREATOR_PRO]) {
      saved.set(
        id,
        await prisma.notificationSettings.findUnique({
          where: { userWawuId: id },
        }),
      );
    }
    purchasesBefore = (
      await prisma.purchase.findMany({
        where: { buyerWawuId: USER_PLAIN },
        select: { id: true },
      })
    ).map((p) => p.id);
    keep = (
      await prisma.notification.findMany({
        where: { userWawuId: { in: USERS } },
        select: { id: true },
      })
    ).map((n) => n.id);
    followedBefore =
      (await prisma.followRelationship.count({
        where: {
          followerWawuId: USER_PLAIN,
          followingWawuId: USER_CREATOR_BASIC,
        },
      })) > 0;
    await clearEmitted();
  }, 40000);

  afterAll(async () => {
    await clearEmitted();
    for (const id of [USER_CREATOR_BASIC, USER_CREATOR_PRO]) {
      const row = saved.get(id) as { userWawuId: string } | null;
      if (row) {
        await prisma.notificationSettings.update({
          where: { userWawuId: id },
          data: row,
        });
      } else {
        await prisma.notificationSettings.deleteMany({
          where: { userWawuId: id },
        });
      }
    }
    await prisma.notificationSettings.deleteMany({
      where: { userWawuId: USER_NO_ROW },
    });
    await prisma.followRelationship.deleteMany({
      where: {
        followerWawuId: USER_PLAIN,
        followingWawuId: USER_CREATOR_BASIC,
      },
    });
    if (followedBefore) {
      await prisma.followRelationship.createMany({
        data: [
          {
            followerWawuId: USER_PLAIN,
            followingWawuId: USER_CREATOR_BASIC,
          },
        ],
        skipDuplicates: true,
      });
    }
    await prisma.purchase.deleteMany({
      where: { buyerWawuId: USER_PLAIN, id: { notIn: purchasesBefore } },
    });
    await app?.close();
    await moduleRef?.close();
    mockWawuId?.kill();
  }, 30000);

  beforeEach(async () => {
    // Every creator starts each test with the switches as an existing account has them.
    for (const id of [USER_CREATOR_BASIC, USER_CREATOR_PRO]) {
      await prisma.notificationSettings.upsert({
        where: { userWawuId: id },
        update: {
          newReplies: true,
          newFollowers: true,
          dmReminders: true,
          refunds: true,
          promotions: true,
          communityDigest: true,
          moneyIn: null,
          contentReviews: null,
          communityMessages: null,
        },
        create: { userWawuId: id },
      });
    }
    await clearEmitted();
  });

  describe('saved and read back through the existing routes', () => {
    it('a user who never touched the new switches reads exactly the six old keys', async () => {
      const res = await read(basicToken).expect(200);
      expect(Object.keys(dataOf(res)).sort()).toEqual([
        'communityDigest',
        'dmReminders',
        'newFollowers',
        'newReplies',
        'promotions',
        'refunds',
        'userWawuId',
      ]);
    });

    it('moneyIn and contentReviews are saved, read back, and changed independently of the six old keys', async () => {
      const off = await patch(basicToken, { moneyIn: false }).expect(200);
      expect(dataOf(off)).toMatchObject({
        moneyIn: false,
        newFollowers: true,
        refunds: true,
      });
      expect(dataOf(off)).not.toHaveProperty('contentReviews');

      await patch(basicToken, { contentReviews: false }).expect(200);
      const got = dataOf(await read(basicToken).expect(200));
      expect(got).toMatchObject({
        moneyIn: false,
        contentReviews: false,
        promotions: true,
      });

      await patch(basicToken, { moneyIn: true, contentReviews: true }).expect(
        200,
      );
      expect(dataOf(await read(basicToken))).toMatchObject({
        moneyIn: true,
        contentReviews: true,
      });
    });

    it('an old-keys-only PATCH leaves a stored new switch alone', async () => {
      await patch(basicToken, { moneyIn: false }).expect(200);
      await patch(basicToken, { newReplies: false }).expect(200);
      expect(dataOf(await read(basicToken))).toMatchObject({
        moneyIn: false,
        newReplies: false,
      });
    });

    it('communityMessages is absent while unset, then saved and read back, and another key leaves it alone', async () => {
      expect(dataOf(await read(basicToken).expect(200))).not.toHaveProperty(
        'communityMessages',
      );

      const off = await patch(basicToken, { communityMessages: false }).expect(
        200,
      );
      expect(dataOf(off)).toMatchObject({
        communityMessages: false,
        newFollowers: true,
      });
      expect(dataOf(off)).not.toHaveProperty('moneyIn');
      expect(dataOf(await read(basicToken).expect(200))).toMatchObject({
        communityMessages: false,
      });

      await patch(basicToken, { refunds: false, moneyIn: false }).expect(200);
      expect(dataOf(await read(basicToken).expect(200))).toMatchObject({
        communityMessages: false,
        refunds: false,
        moneyIn: false,
      });

      await patch(basicToken, { communityMessages: true }).expect(200);
      expect(dataOf(await read(basicToken).expect(200))).toMatchObject({
        communityMessages: true,
      });
    });

    it('communityMessages=false mutes nothing today: no community message kind exists, and every kind that does exist is still delivered', async () => {
      await patch(basicToken, { communityMessages: false }).expect(200);
      expect(
        await notifications.emit({
          kind: 'new_follower',
          userWawuId: USER_CREATOR_BASIC,
        }),
      ).not.toBeNull();
      expect(
        await notifications.emit({
          kind: 'tip_received',
          userWawuId: USER_CREATOR_BASIC,
          netAmount: 10,
        }),
      ).not.toBeNull();
    });

    it('refuses a non-boolean new switch', async () => {
      await patch(basicToken, { moneyIn: 'no' }).expect(400);
      await patch(basicToken, { contentReviews: 1 }).expect(400);
      await patch(basicToken, { communityMessages: 'yes' }).expect(400);
      await patch(basicToken, { communityMessages: 0 }).expect(400);
      await patch(basicToken, { communityMessages: [true] }).expect(400);
    });

    it('a user with no row at all reads the old defaults with no new keys', async () => {
      await prisma.notificationSettings.deleteMany({
        where: { userWawuId: USER_NO_ROW },
      });
      const created = await prisma.notificationSettings.create({
        data: { userWawuId: USER_NO_ROW },
      });
      expect(created.moneyIn).toBeNull();
      expect(created.contentReviews).toBeNull();
      expect(created.communityMessages).toBeNull();
    });
  });

  describe('"New followers" (check 1)', () => {
    it('off: following writes no notification; every other kind still arrives', async () => {
      await patch(basicToken, { newFollowers: false }).expect(200);

      await follow();
      expect(await emittedFor(USER_CREATOR_BASIC, 'new_follower')).toHaveLength(
        0,
      );

      await tip(500, 'mock-flw-sw-1');
      expect(await emittedFor(USER_CREATOR_BASIC, 'tip_received')).toHaveLength(
        1,
      );
      expect(
        await notifications.emit({
          kind: 'dm_received',
          userWawuId: USER_CREATOR_BASIC,
          amount: 300,
        }),
      ).not.toBeNull();
      expect(
        await notifications.emit({
          kind: 'content_rejected',
          userWawuId: USER_CREATOR_BASIC,
          contentTitle: 'X',
        }),
      ).not.toBeNull();
    });

    it('on: following writes the notification', async () => {
      await follow();
      expect(await emittedFor(USER_CREATOR_BASIC, 'new_follower')).toHaveLength(
        1,
      );
    });
  });

  describe('"Money in" (moneyIn)', () => {
    it('off: a settled tip and a settled sale write no notification, and the money still settles', async () => {
      await patch(basicToken, { moneyIn: false }).expect(200);
      await patch(proToken, { moneyIn: false }).expect(200);

      await tip(600, 'mock-flw-sw-2');
      await unlock('mock-flw-sw-3');

      expect(await emittedFor(USER_CREATOR_BASIC, 'tip_received')).toHaveLength(
        0,
      );
      expect(await emittedFor(USER_CREATOR_PRO, 'sale')).toHaveLength(0);
      expect(
        await prisma.purchase.count({
          where: {
            buyerWawuId: USER_PLAIN,
            contentId: CONTENT_PDF_TEMPLATE,
            status: 'completed',
          },
        }),
      ).toBe(1);
    });

    it('off: it does not mute follows or reviews', async () => {
      await patch(basicToken, { moneyIn: false }).expect(200);
      await follow();
      expect(await emittedFor(USER_CREATOR_BASIC, 'new_follower')).toHaveLength(
        1,
      );
      expect(
        await notifications.emit({
          kind: 'content_published',
          userWawuId: USER_CREATOR_BASIC,
          contentTitle: 'X',
        }),
      ).not.toBeNull();
    });

    it('on, and never set: a tip and a sale are written as before', async () => {
      await tip(700, 'mock-flw-sw-4');
      await unlock('mock-flw-sw-5');
      expect(await emittedFor(USER_CREATOR_BASIC, 'tip_received')).toHaveLength(
        1,
      );
      expect(await emittedFor(USER_CREATOR_PRO, 'sale')).toHaveLength(1);

      await clearEmitted();
      await patch(basicToken, { moneyIn: true }).expect(200);
      await tip(800, 'mock-flw-sw-6');
      expect(await emittedFor(USER_CREATOR_BASIC, 'tip_received')).toHaveLength(
        1,
      );
    });
  });

  describe('"Reviews" (contentReviews)', () => {
    it('off: neither an approval nor a send-back is written; other kinds still are', async () => {
      await patch(basicToken, { contentReviews: false }).expect(200);

      expect(
        await notifications.emit({
          kind: 'content_published',
          userWawuId: USER_CREATOR_BASIC,
          contentTitle: 'Owambe',
        }),
      ).toBeNull();
      expect(
        await notifications.emit({
          kind: 'content_rejected',
          userWawuId: USER_CREATOR_BASIC,
          contentTitle: 'Owambe',
          reason: 'Too dark.',
        }),
      ).toBeNull();
      expect(await emittedFor(USER_CREATOR_BASIC)).toHaveLength(0);

      expect(
        await notifications.emit({
          kind: 'kyc_verified',
          userWawuId: USER_CREATOR_BASIC,
          approved: true,
        }),
      ).not.toBeNull();
      await tip(900, 'mock-flw-sw-7');
      expect(await emittedFor(USER_CREATOR_BASIC, 'tip_received')).toHaveLength(
        1,
      );
    });

    it('on, and never set: both are written', async () => {
      expect(
        await notifications.emit({
          kind: 'content_published',
          userWawuId: USER_CREATOR_BASIC,
          contentTitle: 'Owambe',
        }),
      ).not.toBeNull();
      expect(
        await notifications.emit({
          kind: 'content_rejected',
          userWawuId: USER_CREATOR_BASIC,
          contentTitle: 'Owambe',
        }),
      ).not.toBeNull();
    });
  });
});
