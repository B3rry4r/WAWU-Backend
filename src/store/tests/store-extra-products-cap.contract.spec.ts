// Contract tests for task PACK-CAP (R-100): the store grant of the upload pack
// follows the pack rule. Real HTTP, a real database, the real grant code; the
// two stores' servers are stand-ins (test/store/store-standins.ts).
// Run with a mock WAWU ID on its own port, like the other store specs.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/pc2_wawu_hub_test?schema=public';

import { ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AdminRole } from '../../../generated/prisma/enums';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { PLANS_CONFIG, type PlansConfig } from '../../plans/plans-config';
import { StoreGrantService } from '../store-grant.service';
import { PACK_NOT_ALLOWED_CODE } from '../../plans/purchases/extra-products-cap';
import {
  StandInAppStore,
  StandInGooglePlay,
  verified,
} from '../../../test/store/store-standins';
import {
  API,
  BUYER,
  build,
  dataOf,
  ensureMockWawuId,
  mintToken,
  PEOPLE,
  STAND_IN_CONFIG,
} from '../../../test/store/store-test-kit';

jest.setTimeout(120_000);

interface Bought {
  id: string;
  status: string;
  flag: string | null;
  alreadyGranted: boolean;
  grant: { extraProducts: number | null };
}

describe('PACK-CAP: the store grant of the upload pack follows the rule', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let plans: PlansConfig;
  let settings: PlanSettingsService;
  let mock: ChildProcess | undefined;
  let buyer: string;
  let google: StandInGooglePlay;
  let apple: StandInAppStore;
  let buyerToken: string;
  const G = 'wawu_more_products_5_cap';
  const admin: AdminActor = {
    id: randomUUID(),
    email: 'packcap-store@admin.test.wawu.dev',
    role: AdminRole.finance,
  };
  const COUNT = () => plans.extraProducts.count;
  const http = () => request(app.getHttpServer() as Server);
  const post = (token: string, url: string, body: object) =>
    http()
      .post(`${API}${url}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  async function giveTier(tierId: string, extraProducts = 0): Promise<void> {
    const day = 86_400_000;
    await prisma.makerTier.create({
      data: {
        wawuUserId: BUYER,
        tierId,
        activeFrom: new Date(Date.now() - 40 * day),
        activeUntil: new Date(Date.now() + 20 * day),
        productsIncluded: plans.tiers.find((t) => t.id === tierId)!.products,
        extraProducts,
        pointsIncluded: 0,
      },
    });
  }
  const extraOf = async () =>
    (
      await prisma.makerTier.findUniqueOrThrow({
        where: { wawuUserId: BUYER },
        select: { extraProducts: true },
      })
    ).extraProducts;
  const rowsOf = () =>
    prisma.makerExtraProducts.count({ where: { wawuUserId: BUYER } });
  async function wipe(): Promise<void> {
    await prisma.storeNotification.deleteMany({});
    await prisma.makerExtraProducts.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.storePurchase.deleteMany({});
    await prisma.storeSubscription.deleteMany({});
  }
  const resetRule = () =>
    settings.set(admin, {
      settings: {
        'plan.extra_products.tiers': null,
        'plan.extra_products.max_packs': null,
      },
    });
  /** One Google purchase of the pack, posted to the Hub. */
  async function buyPack(token: string) {
    google.oneTime.set(
      token,
      verified({
        accountToken: buyerToken,
        platform: 'android',
        storeProductId: G,
        storeTransactionId: `GPA.${randomUUID().slice(0, 8)}`,
        needsAcknowledge: true,
      }),
    );
    const res = await post(buyer, '/store/purchases', {
      platform: 'android',
      productId: G,
      purchaseToken: token,
    }).expect(201);
    return dataOf<Bought>(res);
  }

  beforeAll(async () => {
    mock = await ensureMockWawuId();
    buyer = mintToken(BUYER);
    google = new StandInGooglePlay();
    apple = new StandInAppStore();
    ({ app, moduleRef } = await build(STAND_IN_CONFIG, google, apple));
    prisma = moduleRef.get(PrismaService);
    plans = moduleRef.get<PlansConfig>(PLANS_CONFIG);
    settings = moduleRef.get(PlanSettingsService);
    buyerToken = dataOf<{ accountToken: string }>(
      await http()
        .get(`${API}/store/products?platform=android`)
        .set('Authorization', `Bearer ${buyer}`)
        .expect(200),
    ).accountToken;
    await wipe();
    await prisma.storeProduct.deleteMany({});
    await prisma.storePlatformSetting.deleteMany({});
    await prisma.storeProduct.create({
      data: {
        platform: 'android',
        kind: 'extra_products',
        storeProductId: G,
        title: 'Add 5 more products',
        grants: { extraProducts: plans.extraProducts.count },
        referenceKobo: null,
      },
    });
  });
  afterAll(async () => {
    if (prisma) {
      await resetRule();
      await wipe();
      await prisma.storeAccountToken.deleteMany({
        where: { wawuUserId: { in: PEOPLE } },
      });
      await prisma.storeProduct.deleteMany({});
      await prisma.storePlatformSetting.deleteMany({});
    }
    await app?.close();
    mock?.kill();
  });
  beforeEach(async () => {
    await wipe();
    await resetRule();
    google.oneTime.clear();
    google.consumed.length = 0;
  });

  for (const id of ['verify', 'plus']) {
    it(`${id}: a pack that arrives is recorded with a flag, grants nothing, and posting it again is the same answer`, async () => {
      await giveTier(id, 0);
      const view = await buyPack('tok-a');
      expect(view).toMatchObject({
        status: 'granted',
        flag: PACK_NOT_ALLOWED_CODE,
        alreadyGranted: false,
        grant: { extraProducts: null },
      });
      expect(await extraOf()).toBe(0);
      expect(await rowsOf()).toBe(0);
      const row = await prisma.storePurchase.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(row).toMatchObject({ flag: PACK_NOT_ALLOWED_CODE });
      expect(row.flaggedAt).not.toBeNull();

      // The app posts it again (a restore): the same row, still nothing, no error.
      const again = await post(buyer, '/store/purchases', {
        platform: 'android',
        productId: G,
        purchaseToken: 'tok-a',
      }).expect(201);
      expect(dataOf<Bought>(again)).toMatchObject({
        id: view.id,
        alreadyGranted: true,
        flag: PACK_NOT_ALLOWED_CODE,
      });
      expect(await extraOf()).toBe(0);
      expect(await prisma.storePurchase.count()).toBe(1);
    });
  }

  it('Founding Maker: a first pack, a second pack, then a third arrives flagged and adds nothing (20 is the most)', async () => {
    const included = plans.tiers.find((t) => t.id === 'founding')!.products;
    await giveTier('founding', 0);
    expect(await buyPack('tok-1')).toMatchObject({
      flag: null,
      grant: { extraProducts: COUNT() },
    });
    expect(await buyPack('tok-2')).toMatchObject({
      flag: null,
      grant: { extraProducts: COUNT() },
    });
    expect(await extraOf()).toBe(2 * COUNT());
    expect(included + (await extraOf())).toBe(included + 2 * COUNT());
    const third = await buyPack('tok-3');
    expect(third).toMatchObject({
      flag: PACK_NOT_ALLOWED_CODE,
      grant: { extraProducts: null },
    });
    expect(await extraOf()).toBe(2 * COUNT());
    expect(await rowsOf()).toBe(2);
  });

  it('a refund of a flagged pack takes nothing back', async () => {
    await giveTier('verify', COUNT());
    const view = await buyPack('tok-r');
    expect(view.flag).toBe(PACK_NOT_ALLOWED_CODE);
    const purchase = await prisma.storePurchase.findUniqueOrThrow({
      where: { id: view.id },
    });
    const grants = moduleRef.get(StoreGrantService);
    const taken = await prisma.$transaction((tx) =>
      grants.takeBack(tx, purchase, new Date()),
    );
    expect(taken).toMatchObject({ extraProducts: 0 });
    expect(await extraOf()).toBe(COUNT());
  });

  it('the settings change the rule for the store path too', async () => {
    await giveTier('verify', 0);
    await settings.set(admin, {
      settings: { 'plan.extra_products.tiers': ['verify', 'founding'] },
    });
    expect(await buyPack('tok-s1')).toMatchObject({ flag: null });
    expect(await extraOf()).toBe(COUNT());
    await settings.set(admin, {
      settings: { 'plan.extra_products.max_packs': 1 },
    });
    expect(await buyPack('tok-s2')).toMatchObject({
      flag: PACK_NOT_ALLOWED_CODE,
    });
    expect(await extraOf()).toBe(COUNT());
  });
});
