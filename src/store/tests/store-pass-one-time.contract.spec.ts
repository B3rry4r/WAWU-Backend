// Contract tests for IAP-03 round 2 (lead ruling on F2): a community pass is a ONE-TIME 30-day
// purchase for one room, not an auto-renewing subscription, because Google and Apple let an
// account hold a subscription product only once, so one subscription per price point could not
// cover two rooms. Google: a consumable in-app product. App Store: a non-renewing subscription.
// Real HTTP and database, stand-in stores. Ports 9510-9529 (the mock WAWU ID on 9510).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/iap3b_wawu_test?schema=public';

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'child_process';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommunityPassReminderService } from '../../community/pass/community-pass-reminder.service';
import { purgePersonPoints } from '../../points/points-purge';
import {
  API,
  BUYER,
  build,
  codeOf,
  dataOf,
  ensureMockWawuId,
  STAND_IN_CONFIG,
  mintToken,
  HOST,
  PEOPLE,
} from '../../../test/store/store-test-kit';
import {
  StandInAppStore,
  StandInGooglePlay,
  verified,
} from '../../../test/store/store-standins';

jest.setTimeout(120_000);

const DAY = 86_400_000;

describe('IAP-03 round 2: a community pass is bought once, for one room', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let a: string;
  let tokenA: string;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  const communityIds: string[] = [];
  const http = () => request(app.getHttpServer() as Server);
  const asA = {
    get: (url: string) =>
      http().get(`${API}${url}`).set('Authorization', `Bearer ${a}`),
    post: (url: string, body: object) =>
      http()
        .post(`${API}${url}`)
        .set('Authorization', `Bearer ${a}`)
        .send(body),
  };
  // Two price points, as the owner would create them: one product each, one store id per point.
  const PASS_A = { android: 'wawu_pass_30_a', ios: 'wawu.pass.30.a' };
  const PASS_B = { android: 'wawu_pass_30_b', ios: 'wawu.pass.30.b' };

  async function room(): Promise<string> {
    const c = await prisma.community.create({
      data: {
        name: `Once room ${randomUUID().slice(0, 8)}`,
        description: 'A private room.',
        hostWawuId: HOST,
        kind: 'private',
        passPrice: { create: { priceKobo: 150_000n } },
      },
    });
    communityIds.push(c.id);
    return c.id;
  }

  const oneTime = (token: string, storeProductId: string, order: string) =>
    google.oneTime.set(
      token,
      verified({
        platform: 'android',
        storeProductId,
        storeTransactionId: order,
        accountToken: tokenA,
        needsAcknowledge: true,
      }),
    );
  const nonRenewing = (id: string, storeProductId: string) =>
    apple.transactions.set(
      id,
      verified({
        platform: 'ios',
        storeProductId,
        storeTransactionId: id,
        accountToken: tokenA,
      }),
    );

  async function wipe(): Promise<void> {
    for (const who of PEOPLE) await purgePersonPoints(prisma, who);
    await prisma.storeNotification.deleteMany({});
    await prisma.communityPass.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.communityMembership.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.storePurchase.deleteMany({});
    await prisma.storeSubscription.deleteMany({});
  }

  beforeAll(async () => {
    mock = await ensureMockWawuId();
    a = mintToken(BUYER);
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(STAND_IN_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    tokenA = dataOf<{ accountToken: string }>(
      await asA.get('/store/products?platform=android').expect(200),
    ).accountToken;
    await wipe();
    await prisma.storeProduct.deleteMany({});
    await prisma.storeProduct.createMany({
      data: (['android', 'ios'] as const).flatMap((platform) =>
        [
          { id: PASS_A[platform], title: 'Pass, point a', worth: 200_000 },
          { id: PASS_B[platform], title: 'Pass, point b', worth: 500_000 },
        ].map((p, i) => ({
          platform,
          kind: 'pass' as const,
          storeProductId: p.id,
          title: p.title,
          grants: { days: 30 },
          referenceKobo: p.worth,
          sortOrder: i,
        })),
      ),
    });
  });

  afterAll(async () => {
    if (prisma) {
      await wipe();
      await prisma.storeAccountToken.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
      await prisma.storeProduct.deleteMany({});
      await prisma.communityPassPrice.deleteMany({
        where: { communityId: { in: communityIds } },
      });
      await prisma.community.deleteMany({
        where: { id: { in: communityIds } },
      });
    }
    await app?.close();
    mock?.kill();
  });

  beforeEach(async () => {
    await wipe();
    google.oneTime.clear();
    google.subscriptions.clear();
    google.consumed.length = 0;
    google.acknowledged.length = 0;
    apple.transactions.clear();
    apple.notifications.clear();
  });

  it('GET /store/products sells a pass as a purchase made once (subscription false), one product per price point, with its days and no price', async () => {
    for (const platform of ['android', 'ios'] as const) {
      const list = dataOf<{
        products: Array<{
          storeProductId: string;
          kind: string;
          subscription: boolean;
          grants: { days: number | null };
        }>;
      }>(await asA.get(`/store/products?platform=${platform}`).expect(200));
      expect(list.products.map((p) => p.storeProductId)).toEqual([
        PASS_A[platform],
        PASS_B[platform],
      ]);
      for (const p of list.products)
        expect(p).toMatchObject({
          kind: 'pass',
          subscription: false,
          grants: { days: 30 },
        });
      expect(JSON.stringify(list)).not.toMatch(/price|kobo/i);
    }
  });

  it('a fan holds a pass to two rooms at the SAME price point: each purchase is its own transaction, granted to the room it names, and each host is credited', async () => {
    const roomA = await room();
    const roomB = await room();
    const buy = (token: string, communityId: string) =>
      asA
        .post('/store/purchases', {
          platform: 'android',
          productId: PASS_A.android,
          purchaseToken: token,
          communityId,
        })
        .expect(201);
    oneTime('tok-ra', PASS_A.android, 'GPA.ra..0');
    const first = dataOf<{ id: string; grant: { communityId: string } }>(
      await buy('tok-ra', roomA),
    );
    // Google had it consumed on the 201, so the same product can be bought again for another room.
    expect(google.consumed).toEqual(['tok-ra']);
    oneTime('tok-rb', PASS_A.android, 'GPA.rb..0');
    const second = dataOf<{ id: string; grant: { communityId: string } }>(
      await buy('tok-rb', roomB),
    );
    expect(first.grant.communityId).toBe(roomA);
    expect(second.grant.communityId).toBe(roomB);
    for (const communityId of [roomA, roomB])
      expect(
        await prisma.communityPass.count({
          where: { communityId, userWawuId: BUYER },
        }),
      ).toBe(1);
    const rows = await prisma.storePurchase.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    for (const r of rows)
      expect(r).toMatchObject({
        creatorWawuUserId: HOST,
        creatorShareKobo: 144_500,
        status: 'granted',
        subscriptionKey: null,
      });
    expect(await prisma.storeSubscription.count()).toBe(0);
    // The same on the App Store: two transactions of one product, two rooms.
    nonRenewing('7001', PASS_B.ios);
    nonRenewing('7002', PASS_B.ios);
    for (const [id, communityId] of [
      ['7001', roomA],
      ['7002', roomB],
    ])
      await asA
        .post('/store/purchases', {
          platform: 'ios',
          productId: PASS_B.ios,
          transactionId: id,
          communityId,
        })
        .expect(201);
    // Room A now holds two stacked periods (60 days), room B two.
    for (const communityId of [roomA, roomB]) {
      const latest = await prisma.communityPass.aggregate({
        where: { communityId, userWawuId: BUYER },
        _max: { endsAt: true },
        _count: true,
      });
      expect(latest._count).toBe(2);
      expect(
        Math.abs((latest._max.endsAt?.getTime() ?? 0) - Date.now() - 60 * DAY),
      ).toBeLessThan(120_000);
    }
  });

  it('renewing is buying again: a purchase after the pass ended starts from now, not from the old end', async () => {
    const communityId = await room();
    oneTime('tok-e1', PASS_A.android, 'GPA.e..0');
    const first = dataOf<{ id: string }>(
      await asA
        .post('/store/purchases', {
          platform: 'android',
          productId: PASS_A.android,
          purchaseToken: 'tok-e1',
          communityId,
        })
        .expect(201),
    );
    // The first pass has run out.
    await prisma.communityPass.update({
      where: { walletPaymentId: `store:${first.id}` },
      data: {
        startsAt: new Date(Date.now() - 31 * DAY),
        endsAt: new Date(Date.now() - DAY),
      },
    });
    oneTime('tok-e2', PASS_A.android, 'GPA.e..1');
    const second = dataOf<{ id: string }>(
      await asA
        .post('/store/purchases', {
          platform: 'android',
          productId: PASS_A.android,
          purchaseToken: 'tok-e2',
          communityId,
        })
        .expect(201),
    );
    const row = await prisma.communityPass.findUniqueOrThrow({
      where: { walletPaymentId: `store:${second.id}` },
    });
    expect(Math.abs(row.startsAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(row.endsAt.getTime() - Date.now() - 30 * DAY)).toBeLessThan(
      60_000,
    );
  });

  it("the App Store's refund of a non-renewing pass takes back that purchase's 30 days", async () => {
    const communityId = await room();
    nonRenewing('7101', PASS_A.ios);
    const bought = dataOf<{ id: string }>(
      await asA
        .post('/store/purchases', {
          platform: 'ios',
          productId: PASS_A.ios,
          transactionId: '7101',
          communityId,
        })
        .expect(201),
    );
    apple.notifications.set('signed-refund', {
      notificationId: 'n-refund-7101',
      type: 'REFUND',
      subtype: null,
      environment: 'production',
      transaction: apple.transactions.get('7101') ?? null,
    });
    const res = await http()
      .post(`${API}/webhooks/app-store`)
      .send({ signedPayload: 'signed-refund' })
      .expect(200);
    expect(dataOf<{ outcome: string }>(res).outcome).toBe('taken_back');
    const row = await prisma.communityPass.findUniqueOrThrow({
      where: { walletPaymentId: `store:${bought.id}` },
    });
    expect(row.endsAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(
      await prisma.storePurchase.findUniqueOrThrow({
        where: { id: bought.id },
      }),
    ).toMatchObject({ status: 'refunded', endReason: 'refunded_by_store' });
  });

  it('the reminder 3 days before the end reaches a pass bought in a store, once, because nothing renews it', async () => {
    const communityId = await room();
    oneTime('tok-m1', PASS_A.android, 'GPA.m..0');
    const bought = dataOf<{ id: string }>(
      await asA
        .post('/store/purchases', {
          platform: 'android',
          productId: PASS_A.android,
          purchaseToken: 'tok-m1',
          communityId,
        })
        .expect(201),
    );
    const emitted: Array<{ kind: string; communityId?: string }> = [];
    const reminders = new CommunityPassReminderService(prisma, {
      emit: (event: { kind: string; communityId?: string }) => {
        emitted.push(event);
        return Promise.resolve();
      },
    } as never);
    // Far from the end: not yet.
    expect(await reminders.run()).toBe(0);
    await prisma.communityPass.update({
      where: { walletPaymentId: `store:${bought.id}` },
      data: {
        startsAt: new Date(Date.now() - 28 * DAY),
        endsAt: new Date(Date.now() + 2 * DAY),
      },
    });
    expect(await reminders.run()).toBe(1);
    expect(emitted).toMatchObject([
      { kind: 'community_pass_ending', communityId },
    ]);
    expect(await reminders.run()).toBe(0);
  });

  it('a pass product is refused without a room, and a store transaction of a pass the Hub does not sell is unknown', async () => {
    oneTime('tok-n1', PASS_A.android, 'GPA.n..0');
    const noRoom = await asA
      .post('/store/purchases', {
        platform: 'android',
        productId: PASS_A.android,
        purchaseToken: 'tok-n1',
      })
      .expect(400);
    expect(codeOf(noRoom)).toBe('store_receipt_missing');
    const unknown = await asA
      .post('/store/purchases', {
        platform: 'android',
        productId: 'wawu_pass_30_zz',
        purchaseToken: 'tok-n1',
        communityId: await room(),
      })
      .expect(404);
    expect(codeOf(unknown)).toBe('store_product_unknown');
  });
});
