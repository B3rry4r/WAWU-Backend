// Contract tests for task IAP-03 (R-65, R-86, G-IAP-02-1): the upload pack, "Add 5 more
// products", is a fifth store product kind, `extra_products`. Real HTTP, a real database,
// the real grant code; the two stores' servers are stand-ins (test/store/store-standins.ts).
// Run with a mock WAWU ID on its own port:
//   WAWU_ID_JWKS_URL=http://localhost:9450/.well-known/jwks.json WAWU_ID_BASE_URL=http://localhost:9450
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iap3_wawu_test?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/iap3_wawu_test?schema=public';

import { ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminTokenService } from '../../admin/auth/admin-token.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { PublishingGate } from '../../plans/publishing-gate.service';
import { TierGateError } from '../../plans/tier-gate-error';
import { INT4_MAX, loadPlansConfig } from '../../plans/plans-config';
import { checkProduct, resolveGrants } from '../store-grants';
import { StoreError } from '../store-error';
import {
  StandInAppStore,
  StandInGooglePlay,
  verified,
} from '../../../test/store/store-standins';
import {
  API,
  BUYER,
  build,
  codeOf,
  dataOf,
  ensureMockWawuId,
  mintToken,
  OTHER,
  PEOPLE,
  STAND_IN_CONFIG,
} from '../../../test/store/store-test-kit';

jest.setTimeout(120_000);

describe('IAP-03: the product map checks an extra_products grant', () => {
  const plans = loadPlansConfig();
  const none = { packId: null, pack: null, tierId: null, days: null };

  it('takes a whole number of products, defaults to the plan count, and carries no reference', () => {
    expect(
      checkProduct('extra_products', { ...none, extraProducts: 5 }, 999, plans),
    ).toEqual({
      grants: { ...none, extraProducts: 5 },
      referenceKobo: null,
    });
    expect(checkProduct('extra_products', none, null, plans)).toEqual({
      grants: { ...none, extraProducts: plans.extraProducts.count },
      referenceKobo: null,
    });
    for (const bad of [0, -1, 1.5, 2_147_483_648])
      expect(() =>
        checkProduct(
          'extra_products',
          { ...none, extraProducts: bad },
          null,
          plans,
        ),
      ).toThrow(StoreError);
    expect(() =>
      checkProduct(
        'extra_products',
        { ...none, extraProducts: 5, days: 3 },
        null,
        plans,
      ),
    ).toThrow(StoreError);
  });

  it('no other kind takes extraProducts under grants', () => {
    expect(() =>
      checkProduct(
        'points',
        { ...none, packId: plans.packs[0].id, extraProducts: 5 },
        null,
        plans,
      ),
    ).toThrow(StoreError);
    expect(() =>
      checkProduct(
        'pass',
        { ...none, days: 30, extraProducts: 5 },
        5000,
        plans,
      ),
    ).toThrow(StoreError);
  });

  it('resolves to the count it adds, and the messages carry no em-dash', () => {
    expect(
      resolveGrants('extra_products', { ...none, extraProducts: 5 }, plans),
    ).toMatchObject({ extraProducts: 5, points: null, credits: null });
    const messages: string[] = [];
    for (const n of [0, 1.5]) {
      try {
        checkProduct(
          'extra_products',
          { ...none, extraProducts: n },
          null,
          plans,
        );
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m).not.toContain('—');
  });
});

describe('IAP-03: buying more products in a store (stand-in stores)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let plans: PlansConfig;
  let mock: ChildProcess | undefined;
  let buyer: string;
  let other: string;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  let buyerToken: string;
  let otherToken: string;
  let tierId: string;
  const adminIds: string[] = [];
  const adminToken: Partial<Record<AdminRole, string>> = {};
  const vb = (over: Parameters<typeof verified>[0]) =>
    verified({ accountToken: buyerToken, ...over });

  const http = () => request(app.getHttpServer() as Server);
  const as = (token: string) => ({
    get: (url: string) =>
      http().get(`${API}${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: object) =>
      http()
        .post(`${API}${url}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  const admin = (role: AdminRole) => ({
    post: (url: string, body: object) =>
      http()
        .post(`${API}${url}`)
        .set('Authorization', `Bearer ${adminToken[role]}`)
        .send(body),
    patch: (url: string, body: object) =>
      http()
        .patch(`${API}${url}`)
        .set('Authorization', `Bearer ${adminToken[role]}`)
        .send(body),
    get: (url: string) =>
      http()
        .get(`${API}${url}`)
        .set('Authorization', `Bearer ${adminToken[role]}`),
  });
  const uid = () => randomUUID().slice(0, 8);

  const G = 'wawu_more_products_5';
  const A = 'wawu.more.products.5';
  const COUNT = () => plans.extraProducts.count;

  /** A tier the person holds: running by default, or ended. */
  async function giveTier(
    wawuUserId: string,
    state: 'running' | 'ended' = 'running',
    extraProducts = 0,
  ): Promise<void> {
    const day = 86_400_000;
    const now = Date.now();
    await prisma.makerTier.create({
      data: {
        wawuUserId,
        tierId,
        activeFrom: new Date(now - 40 * day),
        activeUntil: new Date(now + (state === 'running' ? 20 : -10) * day),
        productsIncluded: plans.tiers[0].products,
        extraProducts,
        pointsIncluded: 0,
      },
    });
  }
  const extraOf = async (wawuUserId: string) =>
    (
      await prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId },
        select: { extraProducts: true },
      })
    ).extraProducts;

  async function wipe(): Promise<void> {
    await prisma.storeNotification.deleteMany({});
    await prisma.makerExtraProducts.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.storePurchase.deleteMany({});
    await prisma.storeSubscription.deleteMany({});
  }

  const googlePack = (
    token: string,
    over: Partial<Parameters<typeof verified>[0]> = {},
  ) => {
    const orderId = `GPA.${uid()}`;
    google.oneTime.set(
      token,
      vb({
        platform: 'android',
        storeProductId: G,
        storeTransactionId: orderId,
        needsAcknowledge: true,
        ...over,
      }),
    );
    return orderId;
  };
  const buyGoogle = (who: string, token: string) =>
    as(who).post('/store/purchases', {
      platform: 'android',
      productId: G,
      purchaseToken: token,
    });

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'iap03-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'iap03-admin-refresh-secret-0123456789abcd',
    }))
      process.env[k] = v;
    mock = await ensureMockWawuId();
    buyer = mintToken(BUYER);
    other = mintToken(OTHER);
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(STAND_IN_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    plans = moduleRef.get<PlansConfig>(PLANS_CONFIG);
    tierId = plans.tiers[0].id;
    // These cases test the grant mechanics on the first tier. The pack rule
    // (PACK-CAP, R-100) is opened for them in the settings; the rule has its own
    // spec (store-extra-products-cap.contract.spec.ts).
    await moduleRef.get(PlanSettingsService).set(
      {
        id: randomUUID(),
        email: 'iap03@admin.test.wawu.dev',
        role: AdminRole.finance,
      },
      {
        settings: {
          'plan.extra_products.tiers': plans.tiers.map((t) => t.id),
          'plan.extra_products.max_packs': INT4_MAX,
        },
      },
    );
    buyerToken = dataOf<{ accountToken: string }>(
      await as(buyer).get('/store/products?platform=android').expect(200),
    ).accountToken;
    otherToken = dataOf<{ accountToken: string }>(
      await as(other).get('/store/products?platform=android').expect(200),
    ).accountToken;
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [AdminRole.finance, AdminRole.support]) {
      const id = randomUUID();
      adminIds.push(id);
      const row = await prisma.adminUser.create({
        data: {
          id,
          email: `iap03-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'x',
          name: `IAP ${role}`,
          role,
        },
      });
      adminToken[role] = issuer.issuePair(row).accessToken;
    }
    await wipe();
    await prisma.storeProduct.deleteMany({});
    await prisma.storePlatformSetting.deleteMany({});
    await prisma.storeProduct.createMany({
      data: [
        {
          platform: 'android',
          kind: 'extra_products',
          storeProductId: G,
          title: 'Add 5 more products',
          grants: { extraProducts: plans.extraProducts.count },
          referenceKobo: null,
        },
        {
          platform: 'ios',
          kind: 'extra_products',
          storeProductId: A,
          title: 'Add 5 more products',
          grants: { extraProducts: plans.extraProducts.count },
          referenceKobo: null,
        },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await wipe();
      await prisma.storeAccountToken.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
      await prisma.storeProduct.deleteMany({});
      await prisma.storePlatformSetting.deleteMany({});
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (prisma)
      await moduleRef.get(PlanSettingsService).set(
        {
          id: randomUUID(),
          email: 'iap03@admin.test.wawu.dev',
          role: AdminRole.finance,
        },
        {
          settings: {
            'plan.extra_products.tiers': null,
            'plan.extra_products.max_packs': null,
          },
        },
      );
    await app?.close();
    mock?.kill();
  });

  beforeEach(async () => {
    await wipe();
    await prisma.storePlatformSetting.deleteMany({});
    google.oneTime.clear();
    google.subscriptions.clear();
    google.consumed.length = 0;
    google.acknowledged.length = 0;
    google.unreachable = false;
    google.failAcknowledge = false;
    apple.transactions.clear();
    apple.notifications.clear();
    apple.unreachable = false;
  });

  // ------------------------------------------------------------------ products

  it('GET /store/products lists the pack with the count it adds, as a pack and not a subscription, with no price', async () => {
    const list = dataOf<{
      available: boolean;
      products: Array<Record<string, unknown>>;
    }>(await as(buyer).get('/store/products?platform=android').expect(200));
    expect(list.available).toBe(true);
    expect(list.products).toHaveLength(1);
    expect(list.products[0]).toMatchObject({
      storeProductId: G,
      kind: 'extra_products',
      subscription: false,
      grants: { extraProducts: COUNT() },
    });
    expect(JSON.stringify(list)).not.toMatch(/price|kobo/i);
  });

  it('a product whose count is gone from its grants is not shown', async () => {
    await prisma.storeProduct.update({
      where: {
        platform_storeProductId: { platform: 'android', storeProductId: G },
      },
      data: { grants: {} },
    });
    try {
      const list = dataOf<{ products: unknown[] }>(
        await as(buyer).get('/store/products?platform=android').expect(200),
      );
      expect(list.products).toHaveLength(0);
    } finally {
      await prisma.storeProduct.update({
        where: {
          platform_storeProductId: { platform: 'android', storeProductId: G },
        },
        data: { grants: { extraProducts: plans.extraProducts.count } },
      });
    }
  });

  // ------------------------------------------------------------------ granting

  it('is checked with Google, adds the products to the tier once, records the purchase, and is consumed', async () => {
    await giveTier(BUYER, 'running', 2);
    const before = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: BUYER },
    });
    googlePack('tok-more');
    const res = await buyGoogle(buyer, 'tok-more').expect(201);
    const view = dataOf<{
      id: string;
      kind: string;
      status: string;
      alreadyGranted: boolean;
      grant: { extraProducts: number };
    }>(res);
    expect(view).toMatchObject({
      kind: 'extra_products',
      status: 'granted',
      alreadyGranted: false,
      grant: { extraProducts: COUNT() },
    });
    const after = await prisma.makerTier.findUniqueOrThrow({
      where: { wawuUserId: BUYER },
    });
    expect(after.extraProducts).toBe(2 + COUNT());
    // Nothing else about the tier moved.
    expect(after.activeUntil.toISOString()).toBe(
      before.activeUntil.toISOString(),
    );
    expect(after.tierId).toBe(before.tierId);
    expect(after.productsIncluded).toBe(before.productsIncluded);
    // What the gate reads: included plus extra.
    const me = dataOf<{ extraProducts: number; productsAllowed: number }>(
      await as(buyer).get('/me/tier').expect(200),
    );
    expect(me).toMatchObject({
      extraProducts: 2 + COUNT(),
      productsAllowed: before.productsIncluded + 2 + COUNT(),
    });
    // The purchase is on record, keyed by the store purchase, in naira.
    const rec = await prisma.makerExtraProducts.findUniqueOrThrow({
      where: { paymentRef: `store:${view.id}` },
    });
    expect(rec).toMatchObject({
      wawuUserId: BUYER,
      tierId,
      products: COUNT(),
      currency: 'NGN',
      amountMinor: plans.extraProducts.price.kobo,
    });
    const row = await prisma.storePurchase.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row).toMatchObject({
      kind: 'extra_products',
      referenceKobo: null,
      netKobo: null,
      creatorWawuUserId: null,
      storeFeeBps: 1500,
    });
    expect(row.grant).toEqual({
      kind: 'extra_products',
      extraProducts: COUNT(),
    });
    expect(google.consumed).toEqual(['tok-more']);
    expect(google.acknowledged).toEqual([]);
  });

  it('the same purchase again, a restore and a race give exactly once', async () => {
    await giveTier(BUYER);
    googlePack('tok-race');
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => buyGoogle(buyer, 'tok-race')),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      201, 201, 201, 201, 201,
    ]);
    const views = results.map((r) =>
      dataOf<{ id: string; alreadyGranted: boolean }>(r),
    );
    expect(new Set(views.map((v) => v.id)).size).toBe(1);
    expect(views.filter((v) => !v.alreadyGranted)).toHaveLength(1);
    expect(await extraOf(BUYER)).toBe(COUNT());
    expect(await prisma.storePurchase.count()).toBe(1);
    expect(
      await prisma.makerExtraProducts.count({ where: { wawuUserId: BUYER } }),
    ).toBe(1);
  });

  it('a second pack is a second purchase and adds again; the wallet and the store add to the same count', async () => {
    await giveTier(BUYER);
    googlePack('tok-one');
    googlePack('tok-two');
    await buyGoogle(buyer, 'tok-one').expect(201);
    await buyGoogle(buyer, 'tok-two').expect(201);
    expect(await extraOf(BUYER)).toBe(2 * COUNT());
    expect(
      await prisma.makerExtraProducts.count({ where: { wawuUserId: BUYER } }),
    ).toBe(2);
  });

  it('an ended tier still gets the pack: the store has been paid, so it waits for the next tier', async () => {
    await giveTier(BUYER, 'ended');
    googlePack('tok-ended');
    await buyGoogle(buyer, 'tok-ended').expect(201);
    expect(await extraOf(BUYER)).toBe(COUNT());
    // It is not counted while no tier runs.
    const me = dataOf<{ state: string; productsAllowed: number }>(
      await as(buyer).get('/me/tier').expect(200),
    );
    expect(me.state).toBe('ended');
  });

  it('a person who has never held a tier has nowhere to put it: refused before the store is asked, with nothing taken or consumed', async () => {
    googlePack('tok-notier');
    const spy = jest.spyOn(google, 'verifyOneTime');
    const res = await buyGoogle(buyer, 'tok-notier').expect(422);
    expect(codeOf(res)).toBe('store_purchase_invalid');
    const message = (res.body as { message: string }).message;
    expect(message).toMatch(/plan/i);
    expect(message).not.toContain('—');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(await prisma.storePurchase.count()).toBe(0);
    expect(await prisma.makerTier.count({ where: { wawuUserId: BUYER } })).toBe(
      0,
    );
    expect(google.consumed).toEqual([]);
  });

  it('the count cannot pass the whole-number column: refused, nothing kept, and nothing consumed', async () => {
    await giveTier(BUYER, 'running', 2_147_483_647 - 1);
    googlePack('tok-big');
    const res = await buyGoogle(buyer, 'tok-big').expect(422);
    expect(codeOf(res)).toBe('store_purchase_invalid');
    expect(await prisma.storePurchase.count()).toBe(0);
    expect(await extraOf(BUYER)).toBe(2_147_483_646);
    expect(google.consumed).toEqual([]);
  });

  it('a Google acknowledgement that fails does not undo the grant, and the next ask finishes it without adding again', async () => {
    await giveTier(BUYER);
    googlePack('tok-ack');
    google.failAcknowledge = true;
    await buyGoogle(buyer, 'tok-ack').expect(201);
    expect(google.consumed).toEqual([]);
    expect(await extraOf(BUYER)).toBe(COUNT());
    google.failAcknowledge = false;
    const again = dataOf<{ alreadyGranted: boolean }>(
      await buyGoogle(buyer, 'tok-ack').expect(201),
    );
    expect(again.alreadyGranted).toBe(true);
    expect(google.consumed).toEqual(['tok-ack']);
    expect(await extraOf(BUYER)).toBe(COUNT());
  });

  // ------------------------------------------------------ the same checks as the other kinds

  it('a purchase the store does not vouch for adds nothing', async () => {
    await giveTier(BUYER);
    // Unknown to Google.
    await buyGoogle(buyer, 'tok-unknown').expect(422);
    // Pending.
    googlePack('tok-pending', { state: 'pending' });
    expect(codeOf(await buyGoogle(buyer, 'tok-pending').expect(409))).toBe(
      'store_purchase_pending',
    );
    // Cancelled.
    googlePack('tok-cancelled', { state: 'cancelled' });
    await buyGoogle(buyer, 'tok-cancelled').expect(422);
    // Another product's token.
    googlePack('tok-other', { storeProductId: 'wawu_points_s' });
    await buyGoogle(buyer, 'tok-other').expect(422);
    // The token is missing.
    await as(buyer)
      .post('/store/purchases', { platform: 'android', productId: G })
      .expect(400);
    expect(await extraOf(BUYER)).toBe(0);
    expect(await prisma.storePurchase.count()).toBe(0);
    expect(google.consumed).toEqual([]);
  });

  it("another person's purchase, and a purchase tied to no one, add nothing", async () => {
    await giveTier(BUYER);
    await giveTier(OTHER);
    // The store says it was bought for the other person's account.
    googlePack('tok-theirs', { accountToken: otherToken });
    const res = await buyGoogle(buyer, 'tok-theirs').expect(409);
    expect(codeOf(res)).toBe('store_purchase_taken');
    // No account token at all: refused from the cutover.
    googlePack('tok-untied', { accountToken: null });
    const untied = await buyGoogle(buyer, 'tok-untied').expect(422);
    expect(codeOf(untied)).toBe('store_account_token_missing');
    // A purchase one person used cannot be used again by another.
    googlePack('tok-shared');
    await buyGoogle(buyer, 'tok-shared').expect(201);
    const taken = await buyGoogle(other, 'tok-shared').expect(409);
    expect(codeOf(taken)).toBe('store_purchase_taken');
    expect(await extraOf(BUYER)).toBe(COUNT());
    expect(await extraOf(OTHER)).toBe(0);
  });

  it('the store switch and the missing keys answer as they do for the other kinds', async () => {
    await giveTier(BUYER);
    googlePack('tok-off');
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/android', { enabled: false })
      .expect(200);
    expect(codeOf(await buyGoogle(buyer, 'tok-off').expect(409))).toBe(
      'store_disabled',
    );
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/android', { enabled: true })
      .expect(200);
    await prisma.storePlatformSetting.deleteMany({});
    expect(await extraOf(BUYER)).toBe(0);
  });

  it('an App Store transaction is read from Apple by id and adds the products once', async () => {
    await giveTier(BUYER);
    apple.transactions.set(
      '7001',
      vb({
        platform: 'ios',
        storeProductId: A,
        storeTransactionId: '7001',
      }),
    );
    const body = { platform: 'ios', productId: A, transactionId: '7001' };
    const ok = await as(buyer).post('/store/purchases', body).expect(201);
    expect(dataOf(ok)).toMatchObject({
      platform: 'ios',
      kind: 'extra_products',
      alreadyGranted: false,
      grant: { extraProducts: COUNT() },
    });
    await as(buyer).post('/store/purchases', body).expect(201);
    expect(await extraOf(BUYER)).toBe(COUNT());
    // The app names one product but the transaction is for another.
    apple.transactions.set(
      '7002',
      vb({
        platform: 'ios',
        storeProductId: 'wawu.points.s',
        storeTransactionId: '7002',
      }),
    );
    await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: A,
        transactionId: '7002',
      })
      .expect(422);
    expect(await extraOf(BUYER)).toBe(COUNT());
  });

  // ------------------------------------------------------------------- refunds

  const push = (note: object) =>
    http()
      .post(`${API}/webhooks/google-play`)
      .set('Authorization', `Bearer ${google.pushToken}`)
      .send({
        message: {
          data: Buffer.from(
            JSON.stringify({ packageName: 'africa.wawu.test', ...note }),
          ).toString('base64'),
          messageId: `m-${uid()}`,
        },
      });
  const voided = (orderId: string, refundType = 1) => ({
    voidedPurchaseNotification: {
      orderId,
      purchaseToken: 'x',
      productType: 2,
      refundType,
    },
  });
  const outcomeOf = (res: request.Response) =>
    dataOf<{ outcome: string }>(res).outcome;

  it('a refund takes the products back, once, and only that purchase', async () => {
    await giveTier(BUYER, 'running', 1);
    const first = googlePack('tok-r1');
    googlePack('tok-r2');
    const a = dataOf<{ id: string }>(
      await buyGoogle(buyer, 'tok-r1').expect(201),
    );
    await buyGoogle(buyer, 'tok-r2').expect(201);
    expect(await extraOf(BUYER)).toBe(1 + 2 * COUNT());
    expect(outcomeOf(await push(voided(first)).expect(200))).toBe('taken_back');
    expect(outcomeOf(await push(voided(first)).expect(200))).toBe('duplicate');
    expect(await extraOf(BUYER)).toBe(1 + COUNT());
    const row = await prisma.storePurchase.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(row).toMatchObject({
      status: 'refunded',
      endReason: 'voided_by_store',
    });
    expect(row.takenBack).toEqual({
      extraProducts: COUNT(),
      grantedExtraProducts: COUNT(),
    });
  });

  it('a chargeback is a revocation and takes them back the same way; a refund works with the store switched off', async () => {
    await giveTier(BUYER);
    const order = googlePack('tok-cb');
    const bought = dataOf<{ id: string }>(
      await buyGoogle(buyer, 'tok-cb').expect(201),
    );
    await admin(AdminRole.finance)
      .patch('/admin/store/platforms/android', { enabled: false })
      .expect(200);
    expect(outcomeOf(await push(voided(order, 2)).expect(200))).toBe(
      'taken_back',
    );
    expect(await extraOf(BUYER)).toBe(0);
    expect(
      (
        await prisma.storePurchase.findUniqueOrThrow({
          where: { id: bought.id },
        })
      ).status,
    ).toBe('revoked');
  });

  it('a refund never takes the count below zero', async () => {
    await giveTier(BUYER);
    const order = googlePack('tok-low');
    await buyGoogle(buyer, 'tok-low').expect(201);
    // Something else already took the products away (an admin fixed the account).
    await prisma.makerTier.update({
      where: { wawuUserId: BUYER },
      data: { extraProducts: 1 },
    });
    expect(outcomeOf(await push(voided(order)).expect(200))).toBe('taken_back');
    expect(await extraOf(BUYER)).toBe(0);
    const row = await prisma.storePurchase.findFirstOrThrow({});
    expect(row.takenBack).toEqual({
      extraProducts: 1,
      grantedExtraProducts: COUNT(),
    });
  });

  it('the real publishing gate (F3): refused at the tier limit, open up to the extra places after the grant, refused again after the refund, and nothing published comes down', async () => {
    await giveTier(BUYER);
    const gate = moduleRef.get(PublishingGate, { strict: false });
    const base = plans.tiers[0].products;
    const published = (n: number) =>
      prisma.creatorState.upsert({
        where: { wawuUserId: BUYER },
        create: { wawuUserId: BUYER, slotsUsed: n },
        update: { slotsUsed: n },
      });
    const gateSays = async () => {
      try {
        await gate.assertRoomForProduct(BUYER);
        return 'open';
      } catch (e) {
        return e instanceof TierGateError ? e.code : 'other';
      }
    };
    const myTier = async () =>
      dataOf<{ productsAllowed: number; productsUsed: number }>(
        await as(buyer).get('/me/tier').expect(200),
      );
    await prisma.creatorState.deleteMany({ where: { wawuUserId: BUYER } });
    // Every place the tier gives is used: the next product is refused.
    await published(base);
    expect(await gateSays()).toBe('product_limit_reached');
    expect(await myTier()).toMatchObject({
      productsAllowed: base,
      productsUsed: base,
    });
    // The pack is bought in the store: the gate opens, one place at a time up to the new limit.
    const order = googlePack('tok-gate');
    await buyGoogle(buyer, 'tok-gate').expect(201);
    expect(await myTier()).toMatchObject({ productsAllowed: base + COUNT() });
    for (let n = base; n < base + COUNT(); n += 1) {
      await published(n);
      expect(await gateSays()).toBe('open');
    }
    await published(base + COUNT());
    expect(await gateSays()).toBe('product_limit_reached');
    // The store pays the pack back: the limit falls to the tier's, the gate refuses
    // the next one again, and the products already published are left up.
    expect(outcomeOf(await push(voided(order)).expect(200))).toBe('taken_back');
    expect(await myTier()).toMatchObject({
      productsAllowed: base,
      productsUsed: base + COUNT(),
    });
    expect(await gateSays()).toBe('product_limit_reached');
    expect(
      (
        await prisma.creatorState.findUniqueOrThrow({
          where: { wawuUserId: BUYER },
        })
      ).slotsUsed,
    ).toBe(base + COUNT());
  });

  it("Apple's refund takes the products back too", async () => {
    await giveTier(BUYER);
    const t = vb({
      platform: 'ios',
      storeProductId: A,
      storeTransactionId: '7101',
    });
    apple.transactions.set('7101', t);
    await as(buyer)
      .post('/store/purchases', {
        platform: 'ios',
        productId: A,
        transactionId: '7101',
      })
      .expect(201);
    apple.notifications.set('signed-r1', {
      notificationId: 'r1',
      type: 'REFUND',
      subtype: null,
      environment: 'production',
      transaction: t,
    });
    const res = await http()
      .post(`${API}/webhooks/app-store`)
      .send({ signedPayload: 'signed-r1' })
      .expect(200);
    expect(outcomeOf(res)).toBe('taken_back');
    expect(await extraOf(BUYER)).toBe(0);
  });

  // ------------------------------------------------------------------- admin

  it('an admin adds the product to the map; it defaults to the plan count, and a bad count is refused with a plain sentence', async () => {
    const create = (b: object) =>
      admin(AdminRole.finance).post('/admin/store/products', b);
    const made = dataOf<{
      id: string;
      kind: string;
      grants: { extraProducts: number };
      resolved: { extraProducts: number };
      referenceKobo: number | null;
    }>(
      await create({
        platform: 'ios',
        storeProductId: 'wawu.more.products.default',
        kind: 'extra_products',
        title: 'Add 5 more products',
        grants: {},
      }).expect(201),
    );
    expect(made).toMatchObject({
      kind: 'extra_products',
      grants: { extraProducts: COUNT() },
      resolved: { extraProducts: COUNT() },
      referenceKobo: null,
    });
    const ten = dataOf<{ id: string; resolved: { extraProducts: number } }>(
      await create({
        platform: 'ios',
        storeProductId: 'wawu.more.products.10',
        kind: 'extra_products',
        title: 'Add 10 more products',
        grants: { extraProducts: 10 },
      }).expect(201),
    );
    expect(ten.resolved.extraProducts).toBe(10);
    const patched = await admin(AdminRole.finance)
      .patch(`/admin/store/products/${ten.id}`, {
        grants: { extraProducts: 20 },
      })
      .expect(200);
    expect(dataOf(patched)).toMatchObject({ resolved: { extraProducts: 20 } });
    for (const grants of [{ extraProducts: 0 }, { extraProducts: 1.5 }]) {
      const res = await create({
        platform: 'ios',
        storeProductId: `wawu.more.products.bad${uid()}`,
        kind: 'extra_products',
        title: 'x',
        grants,
      }).expect(400);
      expect(
        (res.body as { message: string | string[] }).message,
      ).toBeDefined();
    }
    const withOthers = await create({
      platform: 'ios',
      storeProductId: 'wawu.more.products.mixed',
      kind: 'extra_products',
      title: 'x',
      grants: { extraProducts: 5, days: 30 },
    }).expect(400);
    expect(codeOf(withOthers)).toBe('store_product_invalid');
    // A points product cannot carry the count.
    await create({
      platform: 'ios',
      storeProductId: 'wawu.points.mixed',
      kind: 'points',
      title: 'x',
      grants: { packId: plans.packs[0].id, extraProducts: 5 },
    }).expect(400);
    // The support role cannot.
    await admin(AdminRole.support)
      .post('/admin/store/products', {
        platform: 'ios',
        storeProductId: 'nope',
        kind: 'extra_products',
        title: 'x',
        grants: {},
      })
      .expect(403);
    // And the dashboard can filter its purchases by the new kind.
    await giveTier(BUYER);
    googlePack('tok-adm');
    await buyGoogle(buyer, 'tok-adm').expect(201);
    const page = dataOf<{ items: Array<{ kind: string }> }>(
      await admin(AdminRole.finance)
        .get('/admin/store/purchases?kind=extra_products')
        .expect(200),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].kind).toBe('extra_products');
    await prisma.storeProduct.deleteMany({
      where: { id: { in: [made.id, ten.id] } },
    });
  });
});
