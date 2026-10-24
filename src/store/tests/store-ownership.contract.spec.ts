// Contract tests for task IAP-01 fix round 1: a subscription belongs to the person who first
// bought it. Person A buys; person B, who learns A's purchase token (Google) or transaction
// id (Apple, not a secret), must never take it, its renewals or its notices. Real HTTP and
// database, stand-in stores. Ports 8520-8527 (the mock WAWU ID on 8520).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/b27iap_test?schema=public';

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'child_process';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommunityPassService } from '../../community/pass/community-pass.service';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';
import { purgePersonPoints } from '../../points/points-purge';
import { StoreError } from '../store-error';
import { StorePurchaseService } from '../store-purchase.service';
import {
  API,
  BUYER,
  build,
  codeOf,
  dataOf,
  ensureMockWawuId,
  STAND_IN_CONFIG,
  login,
  OTHER,
  HOST,
  PEOPLE,
} from '../../../test/store/store-test-kit';
import {
  inDays,
  StandInAppStore,
  StandInGooglePlay,
  verified,
} from '../../../test/store/store-standins';

jest.setTimeout(120_000);

describe('IAP-01 round 1: another person cannot take a subscription, a renewal of it, or its notices', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let plans: PlansConfig;
  let mock: ChildProcess | undefined;
  let a: string;
  let b: string;
  /** The account tokens `GET /store/products` gave A and B. */
  let tokenA: string;
  let tokenB: string;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  const communityIds: string[] = [];
  const http = () => request(app.getHttpServer() as Server);
  const as = (token: string) => ({
    post: (url: string, body: object) =>
      http()
        .post(`${API}${url}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  const T = { android: 'wawu_tier_own', ios: 'wawu.tier.own' };
  const PASS = { android: 'wawu_pass_own', ios: 'wawu.pass.own' };
  const POINTS = { android: 'wawu_points_own', ios: 'wawu.points.own' };

  const androidSub = (productId: string, order: string, key = 'sub-A') =>
    google.subscriptions.set(
      key,
      verified({
        platform: 'android',
        storeProductId: productId,
        storeTransactionId: order,
        accountToken: tokenA,
        subscriptionKey: key,
        expiresAt: inDays(30),
        needsAcknowledge: true,
      }),
    );
  const iosSub = (productId: string, id: string, key = '5000') =>
    apple.transactions.set(
      id,
      verified({
        platform: 'ios',
        storeProductId: productId,
        storeTransactionId: id,
        accountToken: tokenA,
        subscriptionKey: key,
        expiresAt: inDays(30),
      }),
    );
  const push = (note: object, messageId = `m-${randomUUID()}`) =>
    http()
      .post(`${API}/webhooks/google-play`)
      .set('Authorization', `Bearer ${google.pushToken}`)
      .send({
        message: {
          data: Buffer.from(
            JSON.stringify({ packageName: 'africa.wawu.test', ...note }),
          ).toString('base64'),
          messageId,
        },
      });
  const renewed = (token: string, productId: string) => ({
    subscriptionNotification: {
      notificationType: 2,
      purchaseToken: token,
      subscriptionId: productId,
    },
  });

  async function room(): Promise<string> {
    const c = await prisma.community.create({
      data: {
        name: `Own room ${randomUUID().slice(0, 8)}`,
        description: 'A private room.',
        hostWawuId: HOST,
        kind: 'private',
        passPrice: { create: { priceKobo: 150_000n } },
      },
    });
    communityIds.push(c.id);
    return c.id;
  }

  async function wipe(): Promise<void> {
    for (const who of PEOPLE) await purgePersonPoints(prisma, who);
    await prisma.storeNotification.deleteMany({});
    await prisma.communityPass.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.communityMembership.deleteMany({
      where: { userWawuId: { in: PEOPLE } },
    });
    await prisma.makerPurchase.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.eventPass.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.storePurchase.deleteMany({});
    await prisma.storeSubscription.deleteMany({});
  }

  beforeAll(async () => {
    mock = await ensureMockWawuId();
    a = await login('user@test.wawu.dev');
    b = await login('creator-basic@test.wawu.dev');
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(STAND_IN_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    plans = moduleRef.get<PlansConfig>(PLANS_CONFIG);
    const tokenOf = async (jwt: string) =>
      dataOf<{ accountToken: string }>(
        await http()
          .get(`${API}/store/products?platform=android`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(200),
      ).accountToken;
    tokenA = await tokenOf(a);
    tokenB = await tokenOf(b);
    await wipe();
    await prisma.storeProduct.deleteMany({});
    const tierId = plans.tiers[0].id;
    await prisma.storeProduct.createMany({
      data: (['android', 'ios'] as const).flatMap((platform) => [
        {
          platform,
          kind: 'tier' as const,
          storeProductId: T[platform],
          title: 'Tier',
          grants: { tierId },
        },
        {
          platform,
          kind: 'pass' as const,
          storeProductId: PASS[platform],
          title: 'Pass',
          grants: { days: 30 },
          referenceKobo: 200_000,
        },
        {
          platform,
          kind: 'points' as const,
          storeProductId: POINTS[platform],
          title: 'Points',
          grants: { packId: plans.packs[0].id },
        },
      ]),
    });
  });

  afterAll(async () => {
    if (prisma) {
      await wipe();
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
    google.subscriptions.clear();
    apple.transactions.clear();
    apple.notifications.clear();
  });

  const holds = async (who: string) =>
    (await prisma.makerTier.findUnique({ where: { wawuUserId: who } })) !==
    null;

  it("Google: B posting A's subscription token with a renewed order is refused, and every renewal stays with A", async () => {
    androidSub(T.android, 'GPA.own..0');
    await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-A',
      })
      .expect(201);
    // The store renews to a new order the Hub has not heard of yet.
    androidSub(T.android, 'GPA.own..1');
    const stolen = await as(b)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-A',
      })
      .expect(409);
    expect(codeOf(stolen)).toBe('store_purchase_taken');
    expect(await holds(OTHER)).toBe(false);
    // The renewal notice lands on A, the owner of the subscription.
    androidSub(T.android, 'GPA.own..2');
    const note = await push(renewed('sub-A', T.android)).expect(200);
    expect(dataOf<{ outcome: string }>(note).outcome).toBe('granted');
    const rows = await prisma.storePurchase.findMany({
      where: { subscriptionKey: 'sub-A' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.wawuUserId)).toEqual([BUYER, BUYER]);
    // A can also post the renewed order herself and gets it once.
    const mine = await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-A',
      })
      .expect(201);
    expect(dataOf<{ alreadyGranted: boolean }>(mine).alreadyGranted).toBe(true);
  });

  it("App Store: B posting a later transaction id of A's subscription is refused, and every renewal stays with A", async () => {
    iosSub(T.ios, '5000');
    await as(a)
      .post('/store/purchases', {
        platform: 'ios',
        productId: T.ios,
        transactionId: '5000',
      })
      .expect(201);
    iosSub(T.ios, '5001'); // a renewal; same originalTransactionId
    const stolen = await as(b)
      .post('/store/purchases', {
        platform: 'ios',
        productId: T.ios,
        transactionId: '5001',
      })
      .expect(409);
    expect(codeOf(stolen)).toBe('store_purchase_taken');
    expect(await holds(OTHER)).toBe(false);
    // Apple's DID_RENEW notice for yet another order goes to A.
    const renewal = iosTransaction(T.ios, '5002');
    apple.notifications.set('signed-r2', {
      notificationId: 'n-r2',
      type: 'DID_RENEW',
      subtype: null,
      environment: 'production',
      transaction: renewal,
    });
    const res = await http()
      .post(`${API}/webhooks/app-store`)
      .send({ signedPayload: 'signed-r2' })
      .expect(200);
    expect(dataOf<{ outcome: string }>(res).outcome).toBe('granted');
    const rows = await prisma.storePurchase.findMany({
      where: { subscriptionKey: '5000' },
    });
    expect(rows.map((r) => r.wawuUserId)).toEqual([BUYER, BUYER]);
  });

  const iosTransaction = (productId: string, id: string) =>
    verified({
      platform: 'ios',
      storeProductId: productId,
      storeTransactionId: id,
      accountToken: tokenA,
      subscriptionKey: '5000',
      expiresAt: inDays(30),
    });

  it("a pass subscription is the same: B cannot take A's pass, on either store", async () => {
    const communityId = await room();
    androidSub(PASS.android, 'GPA.pass..0', 'sub-P');
    await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: PASS.android,
        purchaseToken: 'sub-P',
        communityId,
      })
      .expect(201);
    androidSub(PASS.android, 'GPA.pass..1', 'sub-P');
    const g = await as(b)
      .post('/store/purchases', {
        platform: 'android',
        productId: PASS.android,
        purchaseToken: 'sub-P',
        communityId,
      })
      .expect(409);
    expect(codeOf(g)).toBe('store_purchase_taken');
    iosSub(PASS.ios, '6000', '6000');
    await as(a)
      .post('/store/purchases', {
        platform: 'ios',
        productId: PASS.ios,
        transactionId: '6000',
        communityId,
      })
      .expect(201);
    iosSub(PASS.ios, '6001', '6000');
    const i = await as(b)
      .post('/store/purchases', {
        platform: 'ios',
        productId: PASS.ios,
        transactionId: '6001',
        communityId,
      })
      .expect(409);
    expect(codeOf(i)).toBe('store_purchase_taken');
    expect(
      await prisma.communityPass.count({ where: { userWawuId: OTHER } }),
    ).toBe(0);
    expect(
      await prisma.communityMembership.count({ where: { userWawuId: OTHER } }),
    ).toBe(0);
  });

  it('two people posting the same new subscription at once: exactly one holds it', async () => {
    androidSub(T.android, 'GPA.race..0', 'sub-R');
    const results = await Promise.all(
      [a, b, a, b, a, b].map((t) =>
        as(t).post('/store/purchases', {
          platform: 'android',
          productId: T.android,
          purchaseToken: 'sub-R',
        }),
      ),
    );
    const owners = new Set(
      (
        await prisma.storePurchase.findMany({
          where: { subscriptionKey: 'sub-R' },
        })
      ).map((r) => r.wawuUserId),
    );
    expect(owners.size).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- the token

  const productsOf = async (jwt: string) =>
    dataOf<{ accountToken: string }>(
      await http()
        .get(`${API}/store/products?platform=ios`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200),
    ).accountToken;

  it('GET /store/products answers each person their own stable account token, never their user id', async () => {
    const again = await productsOf(a);
    expect(again).toBe(tokenA);
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenA).not.toBe(BUYER);
    expect(tokenB).not.toBe(OTHER);
    // Six at once make one token.
    await prisma.storeAccountToken.deleteMany({ where: { wawuUserId: BUYER } });
    const six = await Promise.all([1, 2, 3, 4, 5, 6].map(() => productsOf(a)));
    expect(new Set(six).size).toBe(1);
    tokenA = six[0];
    expect(
      await prisma.storeAccountToken.count({ where: { wawuUserId: BUYER } }),
    ).toBe(1);
  });

  it("a subscription whose store answer carries no account token is refused, and one that carries another person's is refused", async () => {
    androidSub(T.android, 'GPA.tok..0', 'sub-T');
    google.subscriptions.set(
      'sub-T',
      verified({
        platform: 'android',
        storeProductId: T.android,
        storeTransactionId: 'GPA.tok..0',
        subscriptionKey: 'sub-T',
        expiresAt: inDays(30),
      }),
    );
    const none = await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-T',
      })
      .expect(422);
    expect(codeOf(none)).toBe('store_account_token_missing');
    // The purchase was made for B; A posting it is refused, and B posting it is fine.
    google.subscriptions.set(
      'sub-T',
      verified({
        platform: 'android',
        storeProductId: T.android,
        storeTransactionId: 'GPA.tok..0',
        subscriptionKey: 'sub-T',
        accountToken: tokenB.toUpperCase(),
        expiresAt: inDays(30),
      }),
    );
    const other = await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-T',
      })
      .expect(409);
    expect(codeOf(other)).toBe('store_purchase_taken');
    await as(b)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-T',
      })
      .expect(201);
    expect(await holds(OTHER)).toBe(true);
    expect(await holds(BUYER)).toBe(false);
  });

  it('a pack must carry the token from the cutover; one bought before it may carry none; a pack made for another person is refused', async () => {
    const pack = (token: string, order: string, over: object) =>
      google.oneTime.set(
        token,
        verified({
          platform: 'android',
          storeProductId: POINTS.android,
          storeTransactionId: order,
          ...over,
        }),
      );
    const post = (token: string, who = a) =>
      as(who).post('/store/purchases', {
        platform: 'android',
        productId: POINTS.android,
        purchaseToken: token,
      });
    pack('p-new', 'GPA.pn', { purchasedAt: new Date('2026-10-25T00:00:00Z') });
    expect(codeOf(await post('p-new').expect(422))).toBe(
      'store_account_token_missing',
    );
    pack('p-old', 'GPA.po', { purchasedAt: new Date('2026-10-24T23:59:59Z') });
    await post('p-old').expect(201);
    pack('p-b', 'GPA.pb', { accountToken: tokenB, purchasedAt: new Date() });
    expect(codeOf(await post('p-b').expect(409))).toBe('store_purchase_taken');
    pack('p-a', 'GPA.pa', { accountToken: tokenA, purchasedAt: new Date() });
    await post('p-a').expect(201);
    // A pack with the token A used is A's transaction: B posting it is refused.
    expect(codeOf(await post('p-a', b).expect(409))).toBe(
      'store_purchase_taken',
    );
    // A tokenless pack bought before the cutover cannot be taken by a second person either.
    expect(codeOf(await post('p-old', b).expect(409))).toBe(
      'store_purchase_taken',
    );
  });

  it('the subscription holder is checked on its own, whatever the token says: a second person cannot settle a new order of it', async () => {
    const settle = moduleRef.get(StorePurchaseService);
    const tier = await prisma.storeProduct.findUniqueOrThrow({
      where: {
        platform_storeProductId: {
          platform: 'android',
          storeProductId: T.android,
        },
      },
    });
    const order = (id: string) =>
      verified({
        platform: 'android',
        storeProductId: T.android,
        storeTransactionId: id,
        subscriptionKey: 'sub-H',
        expiresAt: inDays(30),
      });
    await settle.settle({
      userId: BUYER,
      product: tier,
      verified: order('GPA.h..0'),
      communityId: null,
    });
    const rejected = await settle
      .settle({
        userId: OTHER,
        product: tier,
        verified: order('GPA.h..1'),
        communityId: null,
      })
      .catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(StoreError);
    expect((rejected as StoreError).code).toBe('store_purchase_taken');
    expect(await holds(OTHER)).toBe(false);
    expect(
      (
        await prisma.storeSubscription.findMany({
          where: { subscriptionKey: 'sub-H' },
        })
      ).map((r) => r.wawuUserId),
    ).toEqual([BUYER]);
    const ios = await prisma.storeProduct.findUniqueOrThrow({
      where: {
        platform_storeProductId: { platform: 'ios', storeProductId: T.ios },
      },
    });
    const iosOrder = (id: string) =>
      verified({
        platform: 'ios',
        storeProductId: T.ios,
        storeTransactionId: id,
        subscriptionKey: '7000',
        expiresAt: inDays(30),
      });
    await settle.settle({
      userId: BUYER,
      product: ios,
      verified: iosOrder('7000'),
      communityId: null,
    });
    await expect(
      settle.settle({
        userId: OTHER,
        product: ios,
        verified: iosOrder('7001'),
        communityId: null,
      }),
    ).rejects.toMatchObject({ code: 'store_purchase_taken' });
  });

  // ------------------------------------------------------------ notifications

  it("notices follow the subscription's holder, never the newest row, and a renewal made for another account is not granted", async () => {
    androidSub(T.android, 'GPA.n..0', 'sub-N');
    await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-N',
      })
      .expect(201);
    // A row for B with the same key, as an older build could have left it: the newest row.
    const tier = await prisma.storeProduct.findUniqueOrThrow({
      where: {
        platform_storeProductId: {
          platform: 'android',
          storeProductId: T.android,
        },
      },
    });
    await prisma.storePurchase.create({
      data: {
        wawuUserId: OTHER,
        platform: 'android',
        storeTransactionId: 'GPA.n..legacy',
        subscriptionKey: 'sub-N',
        productId: tier.id,
        storeProductId: T.android,
        kind: 'tier',
        environment: 'production',
        grant: {},
        storeFeeBps: 1500,
        purchasedAt: new Date(),
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    androidSub(T.android, 'GPA.n..1', 'sub-N');
    expect(
      dataOf<{ outcome: string }>(
        await push(renewed('sub-N', T.android)).expect(200),
      ).outcome,
    ).toBe('granted');
    expect(
      await prisma.storePurchase.findFirstOrThrow({
        where: { storeTransactionId: 'GPA.n..1' },
      }),
    ).toMatchObject({ wawuUserId: BUYER });
    expect(await holds(OTHER)).toBe(false);
    // A renewal whose store answer says it was made for B's account is not A's.
    google.subscriptions.set(
      'sub-N',
      verified({
        platform: 'android',
        storeProductId: T.android,
        storeTransactionId: 'GPA.n..2',
        subscriptionKey: 'sub-N',
        accountToken: tokenB,
        expiresAt: inDays(30),
      }),
    );
    expect(
      dataOf<{ outcome: string }>(
        await push(renewed('sub-N', T.android)).expect(200),
      ).outcome,
    ).toBe('ignored');
    expect(
      await prisma.storePurchase.count({
        where: { storeTransactionId: 'GPA.n..2' },
      }),
    ).toBe(0);
  });

  it("a lapse marks the holder's subscription ended, and a resubscribe puts it back", async () => {
    androidSub(T.android, 'GPA.l..0', 'sub-L');
    await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-L',
      })
      .expect(201);
    const expiredNote = {
      subscriptionNotification: {
        notificationType: 13,
        purchaseToken: 'sub-L',
        subscriptionId: T.android,
      },
    };
    expect(
      dataOf<{ outcome: string }>(await push(expiredNote).expect(200)).outcome,
    ).toBe('lapsed');
    expect(
      (
        await prisma.storeSubscription.findFirstOrThrow({
          where: { subscriptionKey: 'sub-L' },
        })
      ).lapsedAt,
    ).not.toBeNull();
    androidSub(T.android, 'GPA.l..1', 'sub-L');
    const restarted = {
      subscriptionNotification: {
        notificationType: 7,
        purchaseToken: 'sub-L',
        subscriptionId: T.android,
      },
    };
    expect(
      dataOf<{ outcome: string }>(await push(restarted).expect(200)).outcome,
    ).toBe('granted');
    expect(
      (
        await prisma.storeSubscription.findFirstOrThrow({
          where: { subscriptionKey: 'sub-L' },
        })
      ).lapsedAt,
    ).toBeNull();
  });

  // ----------------------------------------------- a removed member's renewal

  it('a pass renewal for a member the host removed is recorded and flagged, gives no new period, and the pass screen says to cancel in the store', async () => {
    const communityId = await room();
    androidSub(PASS.android, 'GPA.rm..0', 'sub-RM');
    await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: PASS.android,
        purchaseToken: 'sub-RM',
        communityId,
      })
      .expect(201);
    const view = async () => {
      const svc = Object.create(
        CommunityPassService.prototype,
      ) as CommunityPassService;
      Object.assign(svc, {
        prisma,
        blocked: { assertRoomVisible: () => Promise.resolve() },
        access: { passUntil: () => Promise.resolve(null) },
      });
      return svc.pass(communityId, BUYER);
    };
    expect((await view()).cancelInStore).toBe(false);
    // The host removes the member (a pending row).
    await prisma.communityMembership.update({
      where: { userWawuId_communityId: { userWawuId: BUYER, communityId } },
      data: { status: 'pending' },
    });
    expect(await view()).toMatchObject({ canBuy: false, cancelInStore: true });
    androidSub(PASS.android, 'GPA.rm..1', 'sub-RM');
    expect(
      dataOf<{ outcome: string }>(
        await push(renewed('sub-RM', PASS.android)).expect(200),
      ).outcome,
    ).toBe('granted');
    const row = await prisma.storePurchase.findFirstOrThrow({
      where: { storeTransactionId: 'GPA.rm..1' },
    });
    expect(row).toMatchObject({
      wawuUserId: BUYER,
      flag: 'member_removed',
      status: 'granted',
    });
    expect(row.flaggedAt).not.toBeNull();
    expect(
      await prisma.communityPass.count({
        where: { communityId, userWawuId: BUYER },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.communityMembership.findUniqueOrThrow({
          where: { userWawuId_communityId: { userWawuId: BUYER, communityId } },
        })
      ).status,
    ).toBe('pending');
    // The same notice again changes nothing; the admin list shows the flag; a lapse stops the "cancel" message.
    androidSub(PASS.android, 'GPA.rm..1', 'sub-RM');
    expect(
      dataOf<{ outcome: string }>(
        await push(renewed('sub-RM', PASS.android)).expect(200),
      ).outcome,
    ).toBe('duplicate');
    await push({
      subscriptionNotification: {
        notificationType: 13,
        purchaseToken: 'sub-RM',
        subscriptionId: PASS.android,
      },
    }).expect(200);
    expect((await view()).cancelInStore).toBe(false);
  });

  // ----------------------------------------------------------- a failed grant

  it('a grant that throws answers a named 500, keeps nothing, and the next post or notice tries again', async () => {
    const points = await prisma.storeProduct.findUniqueOrThrow({
      where: {
        platform_storeProductId: {
          platform: 'android',
          storeProductId: POINTS.android,
        },
      },
    });
    google.oneTime.set(
      'tok-gf',
      verified({
        platform: 'android',
        storeProductId: POINTS.android,
        storeTransactionId: 'GPA.gf',
        accountToken: tokenA,
        needsAcknowledge: true,
      }),
    );
    // The plan entry the product names has gone.
    await prisma.storeProduct.update({
      where: { id: points.id },
      data: { grants: { packId: 'gone' } },
    });
    const body = {
      platform: 'android',
      productId: POINTS.android,
      purchaseToken: 'tok-gf',
    };
    const failed = await as(a).post('/store/purchases', body).expect(500);
    expect(codeOf(failed)).toBe('store_grant_failed');
    expect((failed.body as { message: string }).message).not.toContain(
      '\u2014',
    );
    expect(await prisma.storePurchase.count()).toBe(0);
    expect(google.consumed).toEqual([]);
    await prisma.storeProduct.update({
      where: { id: points.id },
      data: { grants: { packId: plans.packs[0].id } },
    });
    await as(a).post('/store/purchases', body).expect(201);
    expect(google.consumed).toEqual(['tok-gf']);
    // A notice whose renewal cannot be given is a named 500, not recorded as seen, and the store sends it again.
    androidSub(T.android, 'GPA.gf2..0', 'sub-GF');
    await as(a)
      .post('/store/purchases', {
        platform: 'android',
        productId: T.android,
        purchaseToken: 'sub-GF',
      })
      .expect(201);
    const tier = await prisma.storeProduct.findUniqueOrThrow({
      where: {
        platform_storeProductId: {
          platform: 'android',
          storeProductId: T.android,
        },
      },
    });
    await prisma.storeProduct.update({
      where: { id: tier.id },
      data: { grants: { tierId: 'gone' } },
    });
    androidSub(T.android, 'GPA.gf2..1', 'sub-GF');
    const note = await push(renewed('sub-GF', T.android), 'm-gf').expect(500);
    expect(codeOf(note)).toBe('store_grant_failed');
    expect(
      await prisma.storeNotification.count({ where: { externalId: 'm-gf' } }),
    ).toBe(0);
    await prisma.storeProduct.update({
      where: { id: tier.id },
      data: { grants: { tierId: plans.tiers[0].id } },
    });
    expect(
      dataOf<{ outcome: string }>(
        await push(renewed('sub-GF', T.android), 'm-gf').expect(200),
      ).outcome,
    ).toBe('granted');
  });
});
